import { z } from "zod";
import type { ExpressAdapter, AdapterStatus, ChatSummary, DirectChatSummary, VisibleMessage } from "../adapter/types.js";
import { boundedPage, normalizeLimit, PageInput, PageResult } from "../bounds.js";
import { CursorStore } from "../cursors.js";
import { ExpressError, asExpressError } from "../errors.js";
import { AuthManager } from "./auth.js";
import { decryptMessage, decryptPayload, encryptMessage, PublicKey, WireMessage } from "./crypto.js";
import { SessionHttp } from "./http.js";
import { SessionSocket } from "./socket.js";
import { SessionError } from "./types.js";

import {attachmentMetadata, sendAttachment, downloadAttachment} from "./attachment-client.js";
import type {AttachmentInput, AttachmentSource} from "../attachments.js";

const uuid = z.string().uuid();
const supportedChatTypes = new Set(["chat", "group_chat", "channel", "notes"]);
const chatSchema = z.object({ group_chat_id: uuid, chat_type: z.string(), name: z.string().nullish(), member_huids: z.array(uuid).max(10_000).optional(), unread_count: z.number().nonnegative().optional() }).passthrough();
type Chat = z.infer<typeof chatSchema>;
const keysSchema = z.array(z.object({ id: uuid, body: z.string().max(256), kind: z.string(), user_huid: uuid })).max(2000);
const eventSchema = z.object({ sync_id: uuid, group_chat_id: uuid, event_type: z.string(), inserted_at: z.string().optional() }).passthrough();
const threadSchema = z.object({thread_id: uuid, group_chat_id: uuid, last_event_inserted_at: z.string().nullish()});
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new SessionError("UNSUPPORTED_PROTOCOL"); return result.data;
}

/** One upstream transport; adapters below have no ownership of that transport. */
export class DirectClient {
  private chats = new Map<string, Chat>();
  private listAt = 0;
  private listFlight: Promise<Chat[]> | null = null;
  private subscribed = new Set<string>();
  private seen = new Map<string, number>();
  private epoch: string;
  private lastResyncAt: number | null = null;
  private protocolVerified = false;
  private lastDecryptedAt: number | null = null;
  private readonly activity = (event: {chatId: string; syncId: string}) => {
    const key = `${event.chatId}:${event.syncId}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= 4096) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, Date.now()); this.listAt = 0;
  };
  private readonly connected = () => { this.subscribed.clear(); this.listAt = 0; };
  private readonly changed = () => {
    if (this.epoch !== this.auth.epoch()) { this.epoch = this.auth.epoch(); this.chats.clear(); this.seen.clear(); this.protocolVerified = false; this.lastDecryptedAt = null; }
    this.listAt = 0;
  };
  constructor(readonly auth: AuthManager, readonly http: SessionHttp, readonly socket: SessionSocket) {
    this.epoch = auth.epoch(); socket.on("activity", this.activity); socket.on("connected", this.connected); auth.on("changed", this.changed);
  }
  diagnostics() { return { ...this.auth.diagnostics(), ...this.socket.diagnostics(), lastResyncAt: this.lastResyncAt, protocolState: this.protocolVerified ? "verified" : "unverified", lastDecryptedAt: this.lastDecryptedAt, protocolVersion: "express-3.71.16/v6", e2eMode: "existing-cts-key", cachedChatCount: this.chats.size }; }
  async rest(route: string, method = "GET", body?: unknown): Promise<any> {
    const bundle = await this.auth.credentials();
    const result = await this.http.json(this.http.authorizeCtsOrigin(bundle.ctsOrigin), route, { method, headers: { Authorization: `Bearer ${bundle.accessToken}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    this.auth.authenticated(); return result;
  }
  async list(): Promise<Chat[]> {
    await this.auth.credentials();
    if (this.listAt && Date.now() - this.listAt < 15_000) return [...this.chats.values()];
    if (this.listFlight) return this.listFlight;
    const epoch = this.auth.epoch();
    this.listFlight = (async () => {
      const result = await this.socket.request("system", "chat_list", { since: null, request_version: 6 });
      const chats = checked(z.array(chatSchema).max(10_000), result.chat_list);
      if (epoch !== this.auth.epoch()) throw new SessionError("REAUTH_REQUIRED");
      this.chats = new Map(chats.map(chat => [chat.group_chat_id, chat])); this.listAt = Date.now(); this.lastResyncAt = this.listAt; this.protocolVerified = true; return chats;
    })();
    try { return await this.listFlight; } finally { this.listFlight = null; }
  }
  async target(chatId: string): Promise<Chat> {
    if (!uuid.safeParse(chatId).success) throw new ExpressError("CHAT_NOT_TARGETABLE");
    await this.list(); const chat = this.chats.get(chatId);
    if (!chat || !supportedChatTypes.has(chat.chat_type)) throw new ExpressError("CHAT_NOT_TARGETABLE");
    return chat;
  }
  async titles(chats: Chat[]): Promise<Map<string, string>> {
    const self = (await this.auth.credentials()).accountId;
    const huids = [...new Set(chats.filter(c => c.chat_type === "chat").flatMap(c => c.member_huids ?? []).filter(id => id !== self))];
    const names = new Map<string, string>();
    for (let i = 0; i < huids.length; i += 100) {
      const result = await this.rest("/api/v1/phonebook/cts_profiles/query", "POST", { huids: huids.slice(i, i + 100) });
      const groups = checked(z.array(z.object({cts_profiles: z.array(z.object({user_huid: uuid, name: z.string().max(4096).nullish()})).max(1000)})).max(100), Array.isArray(result) ? result : [result]);
      for (const item of groups.flatMap(group => group.cts_profiles)) {
        const name = item.name?.trim();
        if (name) names.set(item.user_huid, name);
      }
    }
    return new Map(chats.map(c => [c.group_chat_id, (c.chat_type === "chat" ? names.get(c.member_huids?.find(id => id !== self) ?? "") : undefined) || c.name || (c.chat_type === "notes" ? "Заметки" : c.group_chat_id)]));
  }
  async keys(ids: string[]): Promise<PublicKey[]> {
    const unique = [...new Set(ids)]; if (!unique.length) return [];
    checked(z.array(uuid).max(2000), unique);
    const result: PublicKey[] = [];
    for (let i = 0; i < unique.length; i += 100) result.push(...checked(keysSchema, await this.rest(`/api/v1/kdc/keys/?ids=${unique.slice(i, i + 100).join(",")}`)));
    return result;
  }
  async history(chatId: string, limit: number, anchor?: string): Promise<z.infer<typeof eventSchema>[]> {
    await this.target(chatId); return this.historyForTarget(chatId, limit, anchor);
  }
  private async threadParent(chatId: string) {
    const chat = await this.target(chatId);
    if (!["group_chat", "channel"].includes(chat.chat_type)) throw new ExpressError("CHAT_NOT_TARGETABLE");
  }
  async threads(chatId: string, limit: number) {
    await this.threadParent(chatId);
    const result = await this.socket.request("system", "thread_list", {group_chat_id: chatId, limit, request_version: 2});
    const threads = checked(z.array(threadSchema).max(limit), result.thread_list);
    if (threads.some(t => t.group_chat_id !== chatId) || new Set(threads.map(t => t.thread_id)).size !== threads.length) throw new SessionError("UNSUPPORTED_PROTOCOL");
    return threads;
  }
  async threadHistory(chatId: string, threadId: string, limit: number, anchor?: string) {
    await this.threadParent(chatId); checked(uuid, threadId);
    const result = await this.socket.request("system", "thread_info", {thread_id: threadId});
    const info = checked(threadSchema, result.thread_info);
    if (info.thread_id !== threadId || info.group_chat_id !== chatId) throw new ExpressError("CHAT_NOT_TARGETABLE");
    return this.historyForTarget(threadId, limit, anchor);
  }
  private async historyForTarget(chatId: string, limit: number, anchor?: string): Promise<z.infer<typeof eventSchema>[]> {
    await this.socket.ensure();
    if (!this.subscribed.has(chatId)) {
      if (this.subscribed.size >= 128) { this.socket.disconnect(); await this.socket.ensure(); }
      await this.socket.request(`groupchat:${chatId}`, "subscribe_to_chat_activities", { group_chat_id: chatId }); this.subscribed.add(chatId);
    }
    // macOS client TFt/fLt: sync_id is the continuation boundary, not to_sync_id.
    const result = await this.socket.request(`groupchat:${chatId}`, "events_history", { direction: "backward", group_chat_id: chatId, limit, skip_non_affecting_rc: true, skip_to_sync_id_event: true, last_ignore_messages_at: null, ...(anchor ? { sync_id: anchor } : {}) });
    const events = checked(z.array(eventSchema).max(100), result.history);
    if (events.some(e => e.group_chat_id !== chatId)) throw new SessionError("UNSUPPORTED_PROTOCOL");
    const seen = new Set<string>();
    return events.filter(e => { if (e.sync_id === anchor || seen.has(e.sync_id)) return false; seen.add(e.sync_id); return true; });
  }
  async decrypt(events: z.infer<typeof eventSchema>[]): Promise<VisibleMessage[]> {
    const messages = events.filter(e => e.event_type === "message_new") as unknown as WireMessage[];
    const readable = messages.filter(m => m.key && typeof m.payload === "string" && uuid.safeParse(m.sender_key_id).success);
    const keys = await this.keys(readable.flatMap(m => [m.sender_key_id, ...(m.signature && uuid.safeParse(m.signature.sign_key_id).success ? [m.signature.sign_key_id] : [])]));
    const bundle = await this.auth.credentials();
    const result: VisibleMessage[] = [];
    for (const message of messages) {
      const base = {messageId: message.sync_id, ...(message.inserted_at ? {timestamp: message.inserted_at} : {})};
      try {
        if (!readable.includes(message)) throw new SessionError("CRYPTO_KEY_MISSING");
        const clear = await decryptPayload(message, bundle.ctsKey, keys);
        const attachment = attachmentMetadata(clear);
        result.push({...base, text: typeof clear.body === "string" ? clear.body : "", header: message.sender, senderId: message.sender, isSelf: message.sender === bundle.accountId, ...(attachment ? {attachment} : {})});
      } catch (error) {
        // Keep unavailable history explicit without hiding the rest of the page.
        // Never attribute an unverified sender or return unauthenticated plaintext.
        result.push({...base, text: "", decryptionError: asExpressError(error).code});
      }
    }
    if (result.some(m => !m.decryptionError)) this.lastDecryptedAt = Date.now();
    return result;
  }
  async info(chatId: string) {
    await this.target(chatId);
    const response = await this.socket.request("system", "chat_info", {group_chat_id: chatId, request_version: 6});
    const info = checked(chatSchema.extend({keys: z.array(uuid).min(1).max(2000)}), response.chat_info ?? response);
    if (info.group_chat_id !== chatId) throw new SessionError("UNSUPPORTED_PROTOCOL");
    return info;
  }
  async recipientKeys(info: {keys: string[]}) {
    const ids = info.keys; const keys = await this.keys(ids);
    if (keys.length !== ids.length || new Set(ids).size !== ids.length || ids.some(id => !keys.some(k => k.id === id && k.kind === "cts"))) throw new SessionError("CRYPTO_KEY_MISSING");
    return keys;
  }
  async send(chatId: string, text: string): Promise<"verified" | "unknown"> {
    const keys = await this.recipientKeys(await this.info(chatId));
    const bundle = await this.auth.credentials();
    const payload = await encryptMessage(chatId, text, bundle, keys);
    await this.socket.request(`groupchat:${chatId}`, "message_new", payload);
    // An ACK proves acceptance only. Verify the exact ciphertext by sync_id once.
    const events = await this.history(chatId, 50);
    const event = events.find(e => e.sync_id === payload.sync_id && e.payload === payload.payload);
    if (!event) return "unknown";
    const verified = await this.decrypt([event]);
    return verified[0]?.text === text ? "verified" : "unknown";
  }
  close() { this.socket.off("activity", this.activity); this.socket.off("connected", this.connected); this.auth.off("changed", this.changed); this.chats.clear(); this.seen.clear(); }
}

export class DirectAdapter implements ExpressAdapter {
  constructor(private readonly client: DirectClient) {}
  async getChatInfo(chatId: string) {
    const info = await this.client.info(chatId); const self = (await this.client.auth.credentials()).accountId;
    if (!info.member_huids) throw new SessionError("UNSUPPORTED_PROTOCOL");
    return {chatId, title: info.name || chatId, type: info.chat_type, memberCount: info.member_huids.length, onlySelf: info.member_huids.length === 1 && info.member_huids[0] === self};
  }
  async sendAttachment(input: AttachmentInput, source: AttachmentSource, messageId: string) { return sendAttachment(this.client, input, source, messageId); }
  async downloadAttachment(chatId: string, messageId: string) { return downloadAttachment(this.client, chatId, messageId); }
  async status(): Promise<AdapterStatus> {
    await this.client.auth.boot; const session = this.client.diagnostics();
    return { profileReady: true, authentication: session.transportState === "connected" ? "authenticated" : ["missing", "reauth_required", "recovery_required"].includes(session.authState) ? "signed_out" : "unknown", officialOrigin: true, selectorCompatible: session.protocolState === "verified", selectorVersion: "native-protocol-3.71.16", session, guidance: ["missing", "reauth_required", "recovery_required"].includes(session.authState) ? "Run express-mcp login and approve the QR in the official mobile app." : "Status is local diagnostics; list/read provides authenticated upstream proof." };
  }
  async listChats(): Promise<ChatSummary[]> {
    const chats = (await this.client.list()).filter(chat => supportedChatTypes.has(chat.chat_type)); const names = await this.client.titles(chats);
    return chats.map(c => ({ chatId: c.group_chat_id, title: names.get(c.group_chat_id)!, ...(c.unread_count === undefined ? {} : { unreadCount: c.unread_count }) }));
  }
  async searchDirectChats(query: string): Promise<DirectChatSummary[]> {
    const result = await this.client.rest(`/api/v3/phonebook/search?${new URLSearchParams({query, active: "true", disable_fuzzy_search: "false"})}`);
    const phonebook = result.phonebook ?? result.result?.phonebook;
    if (!Array.isArray(phonebook)) throw new SessionError("UNSUPPORTED_PROTOCOL");
    const ids = new Set(phonebook.flatMap((entry: any) => Array.isArray(entry.contacts) ? entry.contacts.map((c: any) => c.user_huid) : []));
    const chats = (await this.client.list()).filter(c => c.chat_type === "chat" && c.member_huids?.some(id => ids.has(id)));
    const names = await this.client.titles(chats);
    return chats.map(c => ({ chatId: c.group_chat_id, title: names.get(c.group_chat_id)!, type: "direct", detail: "Existing direct chat" }));
  }
  async readChat(chatId: string) { return (await this.readChatPage(chatId, {}, new CursorStore())).items; }
  async listThreads(chatId: string, limit: number) {
    normalizeLimit(limit);
    const threads = await this.client.threads(chatId, limit + 1);
    return {...boundedPage(threads.slice(0,limit).map(t => ({threadId: t.thread_id, parentChatId: t.group_chat_id, ...(t.last_event_inserted_at ? {timestamp: t.last_event_inserted_at} : {})})), {limit}, "threads", new CursorStore()), truncated: threads.length > limit};
  }
  async readThreadPage(chatId: string, threadId: string, input: PageInput, cursors: CursorStore) {
    const scope = `thread-history:${this.client.auth.epoch()}:${chatId}:${threadId}`;
    return this.readHistoryPage(input, cursors, scope, (limit, anchor) => this.client.threadHistory(chatId, threadId, limit, anchor));
  }
  async readChatPage(chatId: string, input: PageInput, cursors: CursorStore): Promise<PageResult<VisibleMessage>> {
    const scope = `history:${this.client.auth.epoch()}:${chatId}`;
    return this.readHistoryPage(input, cursors, scope, (limit, anchor) => this.client.history(chatId, limit, anchor));
  }
  private async readHistoryPage(input: PageInput, cursors: CursorStore, scope: string, history: (limit: number, anchor?: string) => Promise<z.infer<typeof eventSchema>[]>) {
    const limit = normalizeLimit(input.limit);
    const previous = input.cursor ? cursors.resolveValue<{anchor: string}>(input.cursor, scope).anchor : undefined;
    const events = await history(limit + 2, previous);
    const selected = events.slice(0, limit); const messages = await this.client.decrypt(selected);
    const bounded = boundedPage(messages, {limit}, "bounded", new CursorStore());
    // Preserve continuation when the byte bound fits fewer messages than events.
    const last = bounded.count < messages.length ? bounded.items.at(-1)?.messageId : selected.at(-1)?.sync_id;
    return { ...bounded, ...(last && (events.length > selected.length || bounded.count < messages.length) ? { nextCursor: cursors.issueValue(scope, {anchor: last}) } : {}) };
  }
  async validateChatTarget(chatId: string) { await this.client.target(chatId); }
  async sendMessage(chatId: string, text: string) { return this.client.send(chatId, text); }
  async close() { /* The broker owns the shared client. */ }
}
