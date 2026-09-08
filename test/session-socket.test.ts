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
