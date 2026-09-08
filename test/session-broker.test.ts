import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Broker, acquireProcessLock } from "../src/session/broker.js";
import { RpcClient } from "../src/session/ipc.js";
import { lockHelperPath } from "../src/session/paths.js";
import { ExpressService } from "../src/service.js";
import { MockExpressAdapter } from "../src/adapter/mock.js";
import { createSafeLogger } from "../src/logger.js";

test("two real IPC clients isolate confirmations, clear them on epoch change and release callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "express-rpc-")); const path = join(root, "s.sock");
  let epoch = "first"; let closed = 0; let created = 0;
  const broker = new Broker(path, () => {
    created++; const adapter = new MockExpressAdapter(); const original = adapter.close.bind(adapter);
    adapter.close = async () => {closed++; await original();};
    return new ExpressService({adapter, logger: createSafeLogger(new Writable({write(_chunk, _encoding, callback) {callback();}}))});
  }, async () => ({ok: true}), () => epoch);
  await broker.start(); const a = new RpcClient(path); const b = new RpcClient(path);
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const [left, right] = await Promise.all([a.call("listChats", {limit: 1}), b.call("listChats", {limit: 1})]);
    const chatId = left.items[0].chatId; assert.equal(right.items[0].chatId, chatId);
    const prepared = await a.call("prepareMessage", {chatId, text: "synthetic"});
    await assert.rejects(b.call("sendMessage", {chatId, text: "synthetic", confirmationToken: prepared.confirmationToken}), /unknown|already been used/);
    epoch = "second";
    await assert.rejects(a.call("sendMessage", {chatId, text: "synthetic", confirmationToken: prepared.confirmationToken}), /unknown|already been used/);
    const next = await a.call("prepareMessage", {chatId, text: "synthetic"});
    assert.equal((await a.call("sendMessage", {chatId, text: "synthetic", confirmationToken: next.confirmationToken})).outcome, "verified");
    await assert.rejects(a.call("sendMessage", {chatId, text: "synthetic", confirmationToken: next.confirmationToken}));
    await assert.rejects(a.call("arbitraryHttp", {url: "https://example.com"}));
  } finally { a.close(); b.close(); await broker.close(); await rm(root, {recursive: true, force: true}); }
  assert.equal(closed, created);
});

test("malformed and oversized RPC input closes the connection without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "express-rpc-")); const path = join(root, "s.sock"); let logins = 0;
  const broker = new Broker(path, () => new ExpressService({adapter: new MockExpressAdapter(), logger: createSafeLogger(new Writable({write(_c,_e,cb) {cb();}}))}), async () => { logins++; });
  await broker.start();
  try {
    for (const frame of ['{"id":"bad","method":"login","params":{}}\n', "x".repeat(500_000)]) {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(path); const timer = setTimeout(() => {socket.destroy(); reject(new Error("connection was not bounded"));}, 3000);
        socket.on("error", () => {}); socket.on("connect", () => socket.write(frame)); socket.on("close", () => {clearTimeout(timer); resolve();});
      });
    }
    assert.equal(logins, 0);
  } finally { await broker.close(); await rm(root, {recursive: true, force: true}); }
});

test("MCP initialize and tools/list work with no broker; status is degraded", async () => {
  const root = await mkdtemp(join(tmpdir(), "express-offline-"));
  const clients: Client[] = [];
  try {
    await Promise.all([1, 2].map(async n => {
      const client = new Client({name: `offline-${n}`, version: "1"}); clients.push(client);
      const transport = new StdioClientTransport({command: process.execPath, args: [new URL("../src/cli.js", import.meta.url).pathname, "serve", "--socket", join(root,"missing.sock")], stderr: "pipe"});
      const start = Date.now(); await client.connect(transport); assert.ok(Date.now() - start < 5000);
      assert.equal((await client.listTools()).tools.length, 12);
      const result = await client.callTool({name: "express_status", arguments: {}});
      const body = JSON.parse((result.content as {text: string}[])[0]!.text); assert.equal(body.status.diagnosticCode, "BROKER_UNAVAILABLE");
    }));
  } finally { await Promise.all(clients.map(c => c.close())); await rm(root, {recursive: true, force: true}); }
});

test("native process lease excludes a second owner and releases on pipe close", {skip: process.platform !== "darwin"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "express-lock-")); const file = join(root,"lease");
  let release = await acquireProcessLock(lockHelperPath(), file);
  try { await assert.rejects(acquireProcessLock(lockHelperPath(), file), /BROKER_BUSY/); }
  finally { release(); }
  await new Promise(resolve => setTimeout(resolve, 50)); release = await acquireProcessLock(lockHelperPath(), file); release();
  await rm(root, {recursive: true, force: true});
});
