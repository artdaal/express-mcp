import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic smoke timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const root = await mkdtemp(path.join(tmpdir(), "express-mcp-smoke-"));
const profile = path.join(root, "profile");
const thisFile = fileURLToPath(import.meta.url);
const cli = path.resolve(path.dirname(thisFile), "../src/cli.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "serve", "--profile-dir", profile],
  env: {
    PATH: process.env.PATH ?? "",
    EXPRESS_MCP_ADAPTER: "mock",
  },
  stderr: "pipe",
  cwd: process.cwd(),
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});
const client = new Client({
  name: "express-mcp-protocol-smoke",
  version: "1.0.0",
});

try {
  await withTimeout(client.connect(transport), 5_000);
  const tools = await withTimeout(client.listTools(), 5_000);
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "express_status",
      "express_list_chats",
      "express_search_direct_chats",
      "express_read_chat",
      "express_list_threads",
      "express_read_thread",
      "express_get_chat_info",
      "express_prepare_attachment",
      "express_send_attachment",
      "express_download_attachment",
      "express_prepare_message",
      "express_send_message",
    ],
  );
  const result = await withTimeout(
    client.callTool({
      name: "express_search_direct_chats",
      arguments: { query: "Synthetic protocol query", limit: 1 },
    }),
    5_000,
  );
  assert.equal(result.isError, undefined);
  assert.equal(stderr.includes("Synthetic"), false);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      initialized: true,
      toolCount: tools.tools.length,
      safeMockCall: "express_search_direct_chats",
      realBrowserStarted: false,
      realSendPossible: false,
    })}\n`,
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
