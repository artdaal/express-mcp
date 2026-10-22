import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { SessionSocket } from "../src/session/socket.js";
import { AuthManager } from "../src/session/auth.js";
import { DEFAULT_CONFIG } from "../src/session/types.js";
import { fixture, MemoryStore } from "./session-fixtures.js";
import { DirectAdapter, DirectClient } from "../src/session/direct.js";
import { SessionHttp } from "../src/session/http.js";
import { CursorStore } from "../src/cursors.js";
import { encryptMessage, WireMessage } from "../src/session/crypto.js";
import { safeErrorBody } from "../src/errors.js";
import { SessionError } from "../src/session/types.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("one socket handles concurrent requests, heartbeat, server paging, decrypt and reconnect", async () => {
  const bundle = {...fixture(Date.now()), refreshAt: null, expiresAt: null}; const chatId = randomUUID();
  const unsupported = ["global", "voex_call", "future_unknown"].map(chat_type => ({group_chat_id: randomUUID(), chat_type}));
  const keys = [{id: bundle.ctsKey.id, body: bundle.ctsKey.public, kind: "cts", user_huid: bundle.accountId}, {id: bundle.signing.id, body: bundle.signing.public, kind: "ed25519", user_huid: bundle.accountId}];
  const events: WireMessage[] = [];
  for (const body of ["newest", "middle", "oldest"]) {
    const payload = await encryptMessage(chatId, body, bundle, [keys[0]!]);
    events.push({...payload, key: payload.keys[0]!, sender: bundle.accountId, sender_key_id: bundle.ctsKey.id, event_type: "message_new"});
  }
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"}); await once(server, "listening");
  let connections = 0; let auths = 0; let beats = 0; let historyAnchor: unknown; let current: WebSocket | undefined;
  server.on("connection", ws => { current = ws; connections++; ws.on("message", data => {
    const req = JSON.parse(data.toString()); let response: unknown = {};
    if (req.event === "authenticate") auths++;
    if (req.event === "heartbeat") beats++;
    if (req.event === "chat_list") response = {chat_list: [...unsupported, {group_chat_id: chatId, chat_type: "notes", name: "Notes"}]};
    if (req.event === "events_history") {
      historyAnchor = req.payload.sync_id; const index = req.payload.sync_id ? events.findIndex(e => e.sync_id === req.payload.sync_id) : 0;
      response = {history: events.slice(Math.max(0, index), Math.max(0,index) + req.payload.limit)};
    }
    if (req.event === "unanswered") return;
    ws.send(JSON.stringify({event: "phx_reply", ref: req.ref, payload: {status: "ok", response}}));
  }); });
  const auth = new AuthManager(new MemoryStore(bundle), async () => ({kind: "ok", accessToken: "rotated", refreshToken: "rotated", expiresIn: null}));
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, (url, origin) => {
    assert.equal(new URL(url).protocol, "wss:"); assert.equal(new URL(url).searchParams.get("key_id"), bundle.ctsKey.id); assert.equal(origin, DEFAULT_CONFIG.webOrigin);
    return new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);
  }, 500, 25);
  const http = new SessionHttp(DEFAULT_CONFIG, async () => new Response(JSON.stringify({result: keys})));
  const client = new DirectClient(auth, http, socket); const adapter = new DirectAdapter(client);
  try {
    await Promise.all(Array.from({length: 20}, () => socket.request("system", "test", {})));
    assert.equal(connections, 1); assert.equal(auths, 1);
    const listed = await adapter.listChats();
    assert.deepEqual(listed, [{chatId, title: "Notes"}]);
    for (const entity of unsupported) await assert.rejects(adapter.validateChatTarget(entity.group_chat_id), /opaque chat reference/);
    const cursors = new CursorStore(); const first = await adapter.readChatPage(listed[0]!.chatId, {limit: 1}, cursors);
    assert.equal(first.items[0]?.text, "newest"); assert.ok(first.nextCursor);
    const second = await adapter.readChatPage(chatId, {limit: 1, cursor: first.nextCursor!}, cursors);
    assert.equal(second.items[0]?.text, "middle"); assert.equal(historyAnchor, events[0]!.sync_id);
    await assert.rejects(adapter.readChatPage(randomUUID(), {cursor: first.nextCursor!}, cursors), /cursor/);
    await new Promise(resolve => setTimeout(resolve, 60)); assert.ok(beats > 0); assert.ok(socket.diagnostics().lastHeartbeatAckAt);
    const pending = socket.request("system", "unanswered", {}); const rejected = assert.rejects(pending, /UPSTREAM_UNAVAILABLE/);
    current!.terminate(); await rejected;
    await socket.ensure(); assert.equal(connections, 2);
    await auth.refresh(); await socket.ensure(); assert.equal(connections, 3);
    assert.equal((await adapter.readChatPage(chatId, {limit: 1}, cursors)).items[0]?.text, "newest");
  } finally { client.close(); socket.close(); await auth.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("native grouped profiles replace generic direct titles and search keeps exact chat identity", async () => {
  const bundle = {...fixture(Date.now()), refreshAt: null, expiresAt: null};
  const peer = randomUUID(); const directId = randomUUID(); const groupId = randomUUID();
  const chats = [
    {group_chat_id: directId, chat_type: "chat", name: "Personal chat", member_huids: [bundle.accountId, peer]},
    {group_chat_id: groupId, chat_type: "group_chat", name: "Project group", member_huids: [bundle.accountId, peer]},
  ];
  const auth = new AuthManager(new MemoryStore(bundle), async () => ({kind: "temporary", code: "UNUSED"}));
  const socket = new SessionSocket(DEFAULT_CONFIG, auth);
  socket.request = async () => ({chat_list: chats});
  let malformed = false;
  const http = new SessionHttp(DEFAULT_CONFIG, async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("cts_profiles/query")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {huids: [peer]});
      return new Response(JSON.stringify({result: malformed ? [{unexpected: []}] : [{cts_profiles: [{user_huid: peer, name: "Example Person"}]}]}));
    }
    assert.equal(new URL(String(url)).searchParams.get("query"), "Example Person");
    return new Response(JSON.stringify({result: {phonebook: [{contacts: [{user_huid: peer}]}]}}));
  });
  const client = new DirectClient(auth, http, socket); const adapter = new DirectAdapter(client);
  try {
    assert.deepEqual(await adapter.listChats(), [{chatId: directId, title: "Example Person"}, {chatId: groupId, title: "Project group"}]);
    const found = await adapter.searchDirectChats("Example Person");
    assert.equal(found.length, 1); assert.equal(found[0]?.chatId, directId); assert.equal(found[0]?.title, "Example Person");
    malformed = true;
    await assert.rejects(adapter.listChats(), /UNSUPPORTED_PROTOCOL/);
  } finally {client.close(); socket.close(); await auth.close();}
});

test("a wanted socket reconnects automatically when initial Keychain restoration becomes usable", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let unlocked = false; let calls = 0; const tokens: string[] = [];
  const bundle = {...fixture(), refreshAt: null, expiresAt: null}; const store = new MemoryStore(bundle); const load = store.load.bind(store);
  store.load = async () => {if (!unlocked) throw new Error("locked"); return load();};
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"}); await once(server, "listening");
  server.on("connection", ws => ws.on("message", data => {
    const request = JSON.parse(data.toString()); if (request.event === "authenticate") tokens.push(request.payload.token);
    ws.send(JSON.stringify({event: "phx_reply", ref: request.ref, payload: {status: "ok", response: {}}}));
  }));
  const auth = new AuthManager(store, async () => {calls++; throw new Error("unexpected exchange");}, () => now);
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, url => {
    assert.equal(new URL(url).searchParams.get("key_id"), bundle.ctsKey.id);
    return new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);
  }, 500, 60_000);
  try {
    await assert.rejects(socket.ensure(), /KEYCHAIN_LOCKED/); auth.start();
    const connected = once(socket, "connected"); unlocked = true; now = auth.diagnostics().nextRetryAt!;
    t.mock.timers.tick(5000); await flush(); await connected;
    assert.deepEqual(tokens, [bundle.accessToken]); assert.equal(calls, 0); assert.equal(socket.diagnostics().transportState, "connected");
    socket.close(); t.mock.timers.tick(50_000); await flush(); assert.equal(tokens.length, 1);
  } finally {socket.close(); await auth.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("a wanted socket reconnects after exact replacement save without replaying a pending write", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let locked = false; let calls = 0; let writes = 0;
  const bundle = {...fixture(), refreshAt: null, expiresAt: null}; const store = new MemoryStore(bundle); const save = store.save.bind(store);
  store.save = async value => {if (value.generation === 1 && locked) throw new Error("locked"); await save(value);};
  const tokens: string[] = []; let sawWrite!: () => void; const written = new Promise<void>(resolve => {sawWrite = resolve;});
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"}); await once(server, "listening");
  server.on("connection", ws => ws.on("message", data => {
    const request = JSON.parse(data.toString());
    if (request.event === "authenticate") tokens.push(request.payload.token);
    if (request.event === "synthetic_message_write") {writes++; sawWrite(); return;}
    ws.send(JSON.stringify({event: "phx_reply", ref: request.ref, payload: {status: "ok", response: {}}}));
  }));
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "recovered-a", refreshToken: "recovered-r", expiresIn: null};}, () => now);
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, url => {
    assert.equal(new URL(url).searchParams.get("key_id"), bundle.ctsKey.id);
    return new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);
  }, 1000, 60_000);
  const client = new DirectClient(auth, new SessionHttp(DEFAULT_CONFIG), socket); const adapter = new DirectAdapter(client);
  try {
    await socket.ensure(); auth.start();
    const pending = assert.rejects(socket.request("system", "synthetic_message_write", {body: "synthetic"}), /UPSTREAM_UNAVAILABLE/);
    await written; locked = true; await auth.refresh(); await pending;
    const status = await adapter.status(); assert.equal(status.authentication, "unknown");
    assert.equal(status.session?.authState, "locked"); assert.equal(status.session?.lastAuthErrorCode, "REFRESH_SAVE_FAILED");
    assert.ok(status.guidance.includes("automatically")); assert.equal(status.guidance.includes("QR"), false);
    const error = await auth.credentials().then(() => assert.fail("credentials must remain unavailable"), value => safeErrorBody(value));
    assert.equal(error.error.code, "KEYCHAIN_LOCKED"); assert.ok(error.error.message.includes("automatically")); assert.equal(error.error.message.includes("restart"), false);
    const connected = once(socket, "connected"); locked = false; now = auth.diagnostics().nextRetryAt!; t.mock.timers.tick(5000); await flush(); await connected;
    assert.deepEqual(tokens, [bundle.accessToken, "recovered-a"]); assert.equal(calls, 1); assert.equal(writes, 1);
    assert.equal((await auth.credentials()).generation, 1);
  } finally {client.close(); socket.close(); await auth.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("closing a wanted socket during Keychain recovery prevents reconnection", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let unlocked = false; let connections = 0; const store = new MemoryStore({...fixture(), refreshAt: null, expiresAt: null}); const load = store.load.bind(store);
  store.load = async () => {if (!unlocked) throw new Error("locked"); return load();};
  const auth = new AuthManager(store, async () => {throw new Error("unexpected exchange");}, () => now);
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, () => {connections++; throw new Error("must not connect");});
  try {
    await assert.rejects(socket.ensure(), /KEYCHAIN_LOCKED/); auth.start(); socket.close();
    unlocked = true; now = auth.diagnostics().nextRetryAt!; t.mock.timers.tick(5000); await flush();
    assert.equal(auth.diagnostics().authState, "ready"); assert.equal(connections, 0); await assert.rejects(socket.ensure(), /BROKER_UNAVAILABLE/);
  } finally {socket.close(); await auth.close();}
});

test("a recovered temporary-result save reconnects with valid credentials and never replays a pending write", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let locked = false; let calls = 0; let writes = 0;
  const bundle = {...fixture(), refreshAt: null}; const store = new MemoryStore(bundle); const save = store.save.bind(store); const tokens: string[] = [];
  store.save = async value => {if (!value.refreshPending && locked) throw new Error("locked"); await save(value);};
  let sawWrite!: () => void; const written = new Promise<void>(resolve => {sawWrite = resolve;});
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"}); await once(server, "listening");
  server.on("connection", ws => ws.on("message", data => {
    const request = JSON.parse(data.toString());
    if (request.event === "authenticate") tokens.push(request.payload.token);
    if (request.event === "synthetic_message_write") {writes++; sawWrite(); return;}
    ws.send(JSON.stringify({event: "phx_reply", ref: request.ref, payload: {status: "ok", response: {}}}));
  }));
  const auth = new AuthManager(store, async () => {calls++; return {kind: "temporary", code: "ENETUNREACH"};}, () => now);
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, () => new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`), 1000, 60_000);
  try {
    await socket.ensure(); auth.start();
    const pending = assert.rejects(socket.request("system", "synthetic_message_write", {body: "synthetic"}), /UPSTREAM_UNAVAILABLE/);
    await written; locked = true; await auth.refresh(); await pending;
    assert.equal(auth.diagnostics().authState, "locked");
    const connected = once(socket, "connected"); locked = false; now = auth.diagnostics().nextRetryAt!;
    t.mock.timers.tick(5000); await flush(); await connected;
    assert.equal(auth.diagnostics().authState, "retry_wait"); assert.deepEqual(tokens, [bundle.accessToken, bundle.accessToken]);
    assert.equal(calls, 1); assert.equal(writes, 1); assert.equal((await auth.credentials()).generation, 0);
    assert.ok(auth.diagnostics().authRecoveryHistory.some(entry => entry.code === "ENETUNREACH"));
  } finally {socket.close(); await auth.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("invalid stored credentials expose a safe terminal diagnostic and existing QR guidance", async () => {
  const store = new MemoryStore(fixture());
  store.load = async () => {throw Object.assign(new SessionError("AUTH_STORE_INVALID"), {message: "SENTINEL_REFRESH_TOKEN", stack: "SENTINEL_STACK"});};
  const auth = new AuthManager(store, async () => {throw new Error("must not exchange");});
  const socket = new SessionSocket(DEFAULT_CONFIG, auth, () => {throw new Error("must not connect");});
  const client = new DirectClient(auth, new SessionHttp(DEFAULT_CONFIG), socket); const adapter = new DirectAdapter(client);
  try {
    const status = await adapter.status(); assert.equal(status.authentication, "signed_out");
    assert.equal(status.session?.authState, "reauth_required"); assert.equal(status.session?.lastAuthErrorCode, "AUTH_STORE_INVALID");
    assert.ok(status.guidance.includes("QR")); assert.equal(status.session?.nextRetryAt, null);
    const error = await auth.credentials().then(() => assert.fail("must stay unavailable"), safeErrorBody);
    assert.equal(error.error.code, "REAUTH_REQUIRED"); assert.equal(JSON.stringify({status, error}).includes("SENTINEL"), false);
  } finally {client.close(); socket.close(); await auth.close();}
});
