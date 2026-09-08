import {attachmentInputSchema} from "../attachments.js";
import { createConnection, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_MESSAGE_TEXT_LENGTH, MAX_SERIALIZED_RESULT_BYTES } from "../constants.js";
import type { ServiceApi } from "../service.js";
import { ExpressError, ErrorCode } from "../errors.js";
import { SessionError } from "./types.js";
import { checkSocket } from "./paths.js";

const page = z.object({ cursor: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const chat = z.string().min(1).max(256); const message = z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH);
export const requestSchema = z.discriminatedUnion("method", [
  z.object({ id: z.string().uuid(), method: z.literal("status"), params: z.object({}).strict() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("listChats"), params: page }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("searchDirectChats"), params: page.extend({ query: z.string().max(1024) }) }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("readChat"), params: page.extend({ chatId: chat }) }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("listThreads"), params: z.object({chatId: chat, limit: z.number().int().min(1).max(50).optional()}).strict() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("readThread"), params: page.extend({chatId: chat, threadId: chat}) }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("prepareMessage"), params: z.object({ chatId: chat, text: message }).strict() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("sendMessage"), params: z.object({ chatId: chat, text: message, confirmationToken: z.string().min(1).max(256) }).strict() }).strict(),
  z.object({id: z.string().uuid(), method: z.literal("getChatInfo"), params: z.object({chatId: chat}).strict()}).strict(),
  z.object({id: z.string().uuid(), method: z.literal("prepareAttachment"), params: attachmentInputSchema}).strict(),
  z.object({id: z.string().uuid(), method: z.literal("sendAttachment"), params: attachmentInputSchema.extend({confirmationToken: z.string().min(1).max(256)}).strict()}).strict(),
  z.object({id: z.string().uuid(), method: z.literal("downloadAttachment"), params: z.object({chatId: chat, messageId: z.string().uuid()}).strict()}).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("login"), params: z.object({}).strict() }).strict(),
]);
export const FRAME_LIMIT = MAX_SERIALIZED_RESULT_BYTES + 64 * 1024;
const cleanPage = (input: {cursor?: string | undefined; limit?: number | undefined}) => ({...(input.cursor ? {cursor: input.cursor} : {}), ...(input.limit === undefined ? {} : {limit: input.limit})});
export async function dispatch(service: ServiceApi, request: z.infer<typeof requestSchema>, login: () => Promise<unknown>) {
  switch (request.method) {
    case "status": return service.status();
    case "listChats": return service.listChats(cleanPage(request.params));
    case "searchDirectChats": return service.searchDirectChats({query: request.params.query, ...cleanPage(request.params)});
    case "readChat": return service.readChat(request.params.chatId, cleanPage(request.params));
    case "listThreads": return service.listThreads(request.params.chatId, request.params.limit);
    case "readThread": return service.readThread(request.params.chatId, request.params.threadId, cleanPage(request.params));
    case "prepareMessage": return service.prepareMessage(request.params.chatId, request.params.text);
    case "sendMessage": return service.sendMessage(request.params.chatId, request.params.text, request.params.confirmationToken);
    case "getChatInfo": return service.getChatInfo(request.params.chatId);
    case "prepareAttachment": return service.prepareAttachment(request.params);
    case "sendAttachment": { const {confirmationToken, ...input} = request.params; return service.sendAttachment(input, confirmationToken); }
    case "downloadAttachment": return service.downloadAttachment(request.params.chatId, request.params.messageId);
    case "login": return login();
  }
}
/** Persistent per-MCP connection: confirmations and cursors never cross callers. */
export class RpcClient {
  private socket: Socket | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  constructor(private readonly path: string, private readonly timeoutMs = 60_000) {}
  private async connect() {
    if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
    if (this.socket && !this.socket.destroyed) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try { await checkSocket(this.path); } catch { throw new SessionError("BROKER_UNAVAILABLE"); }
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(this.path); this.socket = socket;
        const timer = setTimeout(() => { socket.destroy(); reject(new SessionError("BROKER_UNAVAILABLE")); }, 1500);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.on("data", chunk => { if (this.socket === socket) this.receive(chunk); });
        socket.on("error", () => { clearTimeout(timer); reject(new SessionError("BROKER_UNAVAILABLE")); });
        socket.on("close", () => { clearTimeout(timer); if (this.socket === socket) this.disconnect(); reject(new SessionError("BROKER_UNAVAILABLE")); });
      });
    })();
    try { await this.opening; } finally { this.opening = null; }
  }
  async call(method: string, params: object): Promise<any> {
    await this.connect(); if (this.pending.size >= 32) throw new SessionError("BROKER_BUSY");
    const id = randomUUID(); const request = requestSchema.safeParse({id, method, params});
    if (!request.success) throw new ExpressError("INVALID_INPUT");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SessionError("UPSTREAM_TIMEOUT")); }, this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket!.write(JSON.stringify(request.data) + "\n");
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > FRAME_LIMIT) { this.socket?.destroy(); return; }
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      let frame: any;
      try { frame = JSON.parse(this.buffer.subarray(0, end).toString()); } catch { this.socket?.destroy(); return; }
      this.buffer = this.buffer.subarray(end + 1);
      const pending = this.pending.get(frame.id); if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) pending.reject(new ExpressError(frame.error.code as ErrorCode)); else pending.resolve(frame.result);
    }
  }
  private disconnect() {
    this.socket = null; this.buffer = Buffer.alloc(0);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new SessionError("BROKER_UNAVAILABLE")); } this.pending.clear();
  }
  close() { this.closed = true; this.socket?.destroy(); this.disconnect(); }
}
export function proxyService(client: RpcClient): ServiceApi {
  return { status: async () => {
    try { return await client.call("status", {}); }
    catch { return { ok: true, status: {profileReady: false, authentication: "signed_out", officialOrigin: true, selectorCompatible: true, selectorVersion: "native-protocol-3.71.16", diagnosticCode: "BROKER_UNAVAILABLE", guidance: "Run express-mcp install; MCP initialization remains available.", session: {brokerState: "unavailable"}} }; }
  }, getChatInfo: chatId => client.call("getChatInfo", {chatId}), prepareAttachment: input => client.call("prepareAttachment", input), sendAttachment: (input, confirmationToken) => client.call("sendAttachment", {...input, confirmationToken}), downloadAttachment: (chatId, messageId) => client.call("downloadAttachment", {chatId, messageId}), listChats: input => client.call("listChats", input), searchDirectChats: input => client.call("searchDirectChats", input), readChat: (chatId, input) => client.call("readChat", {chatId, ...input}), listThreads: (chatId, limit) => client.call("listThreads", {chatId, ...(limit === undefined ? {} : {limit})}), readThread: (chatId, threadId, input) => client.call("readThread", {chatId, threadId, ...input}), prepareMessage: (chatId, text) => client.call("prepareMessage", {chatId, text}), sendMessage: (chatId, text, confirmationToken) => client.call("sendMessage", {chatId, text, confirmationToken}), close: async () => client.close() };
}
