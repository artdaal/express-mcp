#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ExpressAdapter } from "./adapter/types.js";
import {
  PlaywrightExpressAdapter,
  runHeadedLogin,
} from "./adapter/browser.js";
import { MockExpressAdapter } from "./adapter/mock.js";
import {
  DEFAULT_PAGE_LIMIT,
  SELECTOR_BUNDLE_VERSION,
} from "./constants.js";
import { ExpressError, asExpressError, safeErrorBody } from "./errors.js";
import { createSafeLogger } from "./logger.js";
import {
  liveSearchSmokeAggregate,
  liveSmokeBounds,
} from "./live-smoke.js";
import { createMcpServer } from "./mcp.js";
import {
  acquireProfileLease,
  applyRestrictiveUmask,
  resolveProfileDir,
  type ProfileLease,
} from "./profile.js";
import { ExpressService } from "./service.js";
import { RpcClient, proxyService } from "./session/ipc.js";
import { helperPath, socketPath, projectRoot } from "./session/paths.js";
import { KeychainStore } from "./session/store.js";
import { runDaemon } from "./session/broker.js";
import { runAgentCommand } from "./agent.js";
import { configure } from "./configure.js";
import { spawn } from "node:child_process";
import path from "node:path";

interface CliOptions {
  command?: string;
  profileDir?: string;
  chatId?: string;
  chatIndex?: number;
  query?: string;
  help: boolean;
  socket?: string;
}

function parseArguments(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  let profileDir: string | undefined;
  let chatId: string | undefined;
  let chatIndex: number | undefined;
  let query: string | undefined;
  let help = command === "--help" || command === "-h";
  let socket: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--socket") { socket = rest[++index]; if (!socket || !path.isAbsolute(socket)) throw new ExpressError("INVALID_INPUT"); continue; }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--profile-dir") {
      profileDir = rest[index + 1];
      if (!profileDir) {
        throw new ExpressError("INVALID_INPUT");
      }
      index += 1;
      continue;
    }
    if (argument === "--chat-id") {
      chatId = rest[index + 1];
      if (!chatId) {
        throw new ExpressError("INVALID_INPUT");
      }
      index += 1;
      continue;
    }
    if (argument === "--chat-index") {
      const rawIndex = rest[index + 1];
      chatIndex = rawIndex ? Number(rawIndex) : Number.NaN;
      if (
        !Number.isSafeInteger(chatIndex) ||
        chatIndex < 1 ||
        chatIndex > 50
      ) {
        throw new ExpressError("INVALID_INPUT");
      }
      index += 1;
      continue;
    }
    if (argument === "--query") {
      query = rest[index + 1];
      if (query === undefined) {
        throw new ExpressError("INVALID_INPUT");
      }
      index += 1;
      continue;
    }
    throw new ExpressError("INVALID_INPUT");
  }
  return {
    ...(command && !command.startsWith("-") ? { command } : {}),
    ...(profileDir ? { profileDir } : {}),
    ...(chatId ? { chatId } : {}),
    ...(chatIndex ? { chatIndex } : {}),
    ...(query !== undefined ? { query } : {}),
    help,
    ...(socket ? {socket} : {}),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  express-mcp configure < deployment.json",
    "  express-mcp agent < request.json",
    "  express-mcp install",
    "  express-mcp daemon",
    "  express-mcp login",
    "  express-mcp status",
    "  express-mcp serve [--socket <path>]",
    "  express-mcp session-smoke [--chat-index <1-50>]",
    "  express-mcp legacy-login [--profile-dir <path>]",
    "  express-mcp legacy-status [--profile-dir <path>]",
    "  express-mcp legacy-serve [--profile-dir <path>]",
    "  express-mcp live-smoke (--chat-index <1-50> | --chat-id <opaque-id>) [--profile-dir <path>]",
    "  express-mcp live-search-smoke --query <colleague-query> [--profile-dir <path>]",
  ].join("\n");
}

async function runProxy(socket: string) {
  const service = proxyService(new RpcClient(socket));
  const server = createMcpServer(service, createSafeLogger());
  let stop!: () => void; const stopped = new Promise<void>(resolve => {stop = resolve;});
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.stdin.once("end", stop);
  try { await server.connect(new StdioServerTransport()); await stopped; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.stdin.off("end", stop); await server.close(); await service.close(); }
}

async function sessionCommand(command: string, socket: string, index = 1) {
  const client = new RpcClient(socket);
  try {
    if (command === "status") { process.stdout.write(JSON.stringify(await proxyService(client).status()) + "\n"); return; }
    if (command === "login") {
      const login = await client.call("login", {});
      await new KeychainStore(helperPath()).openLogin(login.url);
      process.stdout.write(JSON.stringify({ok: true, enrollment: "opened_locally", expiresAt: login.expiresAt}) + "\n"); return;
    }
    const status = await client.call("status", {});
    const chats = await client.call("listChats", {limit: index}); const chatId = chats.items[index - 1]?.chatId;
    if (!chatId) throw new ExpressError("CHAT_NOT_TARGETABLE");
    const history = await client.call("readChat", {chatId, limit: 1});
    process.stdout.write(JSON.stringify({ok: true, live: true, listedCount: chats.count, decryptedMessageCount: history.count, hasHistoryCursor: Boolean(history.nextCursor), generation: status.status.session?.generation, sentMessages: 0}) + "\n");
  } finally { client.close(); }
}

async function createAdapter(
  lease: ProfileLease,
): Promise<ExpressAdapter> {
  if (process.env.EXPRESS_MCP_ADAPTER === "mock") {
    return new MockExpressAdapter();
  }
  return PlaywrightExpressAdapter.launch({
    profileDir: lease.profileDir,
    headless: true,
    ...(process.env.EXPRESS_MCP_CHROME_EXECUTABLE
      ? { executablePath: process.env.EXPRESS_MCP_CHROME_EXECUTABLE }
      : {}),
  });
}

async function withLease<T>(
  selectedProfile: string | undefined,
  operation: (lease: ProfileLease) => Promise<T>,
): Promise<T> {
  const logger = createSafeLogger();
  const profileDir = resolveProfileDir({
    ...(selectedProfile ? { flagValue: selectedProfile } : {}),
  });
  const lease = await acquireProfileLease(profileDir);
  if (lease.permissionWarning) {
    logger.warn({
      operation: "profile_permissions",
      code: "PROFILE_PERMISSION_WARNING",
    });
  }
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}

async function runLogin(profileDir: string | undefined): Promise<void> {
  const result = await withLease(profileDir, async (lease) =>
    runHeadedLogin({
      profileDir: lease.profileDir,
      ...(process.env.EXPRESS_MCP_CHROME_EXECUTABLE
        ? { executablePath: process.env.EXPRESS_MCP_CHROME_EXECUTABLE }
        : {}),
    }),
  );
  if (result === "cancelled") {
    throw new ExpressError("LOGIN_CANCELLED");
  }
  if (result === "unsupported") {
    throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      authentication: "authenticated",
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    })}\n`,
  );
}

async function runStatus(profileDir: string | undefined): Promise<void> {
  await withLease(profileDir, async (lease) => {
    const adapter = await createAdapter(lease);
    const service = new ExpressService({
      adapter,
      logger: createSafeLogger(),
    });
    try {
      process.stdout.write(`${JSON.stringify(await service.status())}\n`);
    } finally {
      await service.close();
    }
  });
}

async function runServe(profileDir: string | undefined): Promise<void> {
  await withLease(profileDir, async (lease) => {
    const adapter = await createAdapter(lease);
    const logger = createSafeLogger();
    const service = new ExpressService({ adapter, logger });
    const server = createMcpServer(service, logger);
    const transport = new StdioServerTransport();
    let stop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const onSignal = () => stop?.();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.stdin.once("end", onSignal);
    try {
      await server.connect(transport);
      await stopped;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.stdin.removeListener("end", onSignal);
      await server.close().catch(() => undefined);
      await service.close();
    }
  });
}

async function runLiveSmoke(
  profileDir: string | undefined,
  chatId: string | undefined,
  chatIndex: number | undefined,
): Promise<void> {
  if ((!chatId && !chatIndex) || (chatId && chatIndex)) {
    throw new ExpressError("INVALID_INPUT");
  }
  await withLease(profileDir, async (lease) => {
    const adapter = await createAdapter(lease);
    if (adapter instanceof MockExpressAdapter) {
      throw new ExpressError("INVALID_INPUT");
    }
    const service = new ExpressService({
      adapter,
      logger: createSafeLogger(),
    });
    try {
      const status = await service.status();
      const listLimit = chatIndex ? Math.max(chatIndex, 1) : 1;
      const chats = await service.listChats({
        limit: listLimit,
      });
      const selectedChatId =
        chatId ?? chats.items[(chatIndex ?? 1) - 1]?.chatId;
      if (!selectedChatId) {
        throw new ExpressError("CHAT_NOT_TARGETABLE");
      }
      const messages = await service.readChat(selectedChatId, { limit: 1 });
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          selectorVersion: status.status.selectorVersion,
          authenticated:
            status.status.authentication === "authenticated",
          officialOrigin: status.status.officialOrigin,
          selectorCompatible: status.status.selectorCompatible,
          ...liveSmokeBounds(chats.count, listLimit, messages.count, 1),
          note:
            "Read-only content access completed; opening the selected already-read/self chat may clear unread state.",
        })}\n`,
      );
    } finally {
      await service.close();
    }
  });
}

async function runLiveSearchSmoke(
  profileDir: string | undefined,
  query: string | undefined,
): Promise<void> {
  if (query === undefined) {
    throw new ExpressError("INVALID_INPUT");
  }
  await withLease(profileDir, async (lease) => {
    const adapter = await createAdapter(lease);
    if (adapter instanceof MockExpressAdapter) {
      throw new ExpressError("INVALID_INPUT");
    }
    const service = new ExpressService({
      adapter,
      logger: createSafeLogger(),
    });
    let searchActive = false;
    try {
      const status = await service.status();
      searchActive = true;
      const results = await service.searchDirectChats({
        query,
        limit: DEFAULT_PAGE_LIMIT,
      });
      await adapter.listChats();
      searchActive = false;
      process.stdout.write(
        `${JSON.stringify(
          liveSearchSmokeAggregate({
            selectorVersion: status.status.selectorVersion,
            requestedLimit: DEFAULT_PAGE_LIMIT,
            returnedResultCount: results.count,
            truncated: results.truncated,
            allResultsDirect: results.items.every(
              (item) => item.type === "direct",
            ),
            searchStateCleared: true,
          }),
        )}\n`,
      );
    } catch (error) {
      if (searchActive) {
        await adapter.listChats().catch(() => undefined);
      }
      throw error;
    } finally {
      await service.close();
    }
  });
}

async function main(): Promise<void> {
  applyRestrictiveUmask();
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  switch (options.command) {
    case "configure": await configure(); return;
    case "agent": await runAgentCommand(options.socket); return;
    case "login":
    case "status":
    case "session-smoke":
      await sessionCommand(options.command, options.socket ?? socketPath(), options.chatIndex); return;
    case "daemon": await runDaemon(); return;
    case "install":
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(projectRoot(), "scripts/install.mjs")], {stdio: "inherit"});
        child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new ExpressError("INTERNAL_ERROR")));
      }); return;
    case "legacy-login":
      await runLogin(options.profileDir);
      return;
    case "legacy-status":
      await runStatus(options.profileDir);
      return;
    case "serve":
      if (process.env.EXPRESS_MCP_ADAPTER !== "mock") { await runProxy(options.socket ?? socketPath()); return; }
      await runServe(options.profileDir); return;
    case "legacy-serve":
      await runServe(options.profileDir);
      return;
    case "live-smoke":
      await runLiveSmoke(
        options.profileDir,
        options.chatId,
        options.chatIndex,
      );
      return;
    case "live-search-smoke":
      await runLiveSearchSmoke(options.profileDir, options.query);
      return;
    default:
      throw new ExpressError("INVALID_INPUT");
  }
}

main().catch((error: unknown) => {
  const safe = asExpressError(error);
  createSafeLogger().error({
    operation: "cli",
    code: safe.code,
  });
  process.stderr.write(`${JSON.stringify(safeErrorBody(safe))}\n`);
  process.exitCode = 1;
});
