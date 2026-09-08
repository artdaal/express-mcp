import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { ExpressError } from "./errors.js";
import { attachmentInputSchema } from "./attachments.js";

const id = z.string().min(1).max(256);
const paged = {limit: z.number().int().min(1).max(50).default(20), pages: z.number().int().min(1).max(20).default(1)};
export const agentRequestSchema = z.discriminatedUnion("operation", [
  z.object({operation: z.literal("status")}).strict(),
  z.object({operation: z.literal("list-chats"), ...paged}).strict(),
  z.object({operation: z.literal("search-chats"), query: z.string().min(1).max(256), ...paged}).strict(),
  z.object({operation: z.literal("search-people"), query: z.string().min(1).max(256), ...paged}).strict(),
  z.object({operation: z.literal("read-chat"), chatId: id, ...paged}).strict(),
  z.object({operation: z.literal("list-threads"), chatId: id, limit: paged.limit}).strict(),
  z.object({operation: z.literal("read-thread"), chatId: id, threadId: id, ...paged}).strict(),
  z.object({operation: z.literal("chat-info"), chatId: id}).strict(),
  z.object({operation: z.literal("send-message"), chatId: id, text: z.string().min(1).max(65536), confirmed: z.literal(true)}).strict(),
  attachmentInputSchema.extend({operation: z.literal("send-attachment"), confirmed: z.literal(true)}).strict(),
  z.object({operation: z.literal("download-attachment"), chatId: id, messageId: z.string().uuid()}).strict(),
]);
export async function readInput(limit = 128 * 1024, input: AsyncIterable<Buffer | string> = process.stdin): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) { const value = Buffer.from(chunk); size += value.length; if (size > limit) throw new ExpressError("INVALID_INPUT"); chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ExpressError("INVALID_INPUT"); }
}
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<any>;
export async function agentOperation(raw: unknown, call: ToolCall): Promise<any> {
  const parsed = agentRequestSchema.safeParse(raw); if (!parsed.success) throw new ExpressError("INVALID_INPUT");
  const input = parsed.data;
  if (input.operation === "status") return call("express_status", {});
  if (input.operation === "chat-info") return call("express_get_chat_info", {chatId: input.chatId});
  if (input.operation === "download-attachment") return call("express_download_attachment", {chatId: input.chatId, messageId: input.messageId});
  if (input.operation === "list-threads") return call("express_list_threads", {chatId: input.chatId, limit: input.limit});
  if (input.operation === "send-message" || input.operation === "send-attachment") {
    const {operation, confirmed, ...args} = input;
    const suffix = operation === "send-message" ? "message" : "attachment";
    const prepared = await call(`express_prepare_${suffix}`, args);
    if (!prepared.ok || typeof prepared.confirmationToken !== "string") throw new ExpressError("INTERNAL_ERROR");
    // The token never leaves this connection. User authorization is represented
    // by confirmed:true; this is a binding mechanism, not an authorization UI.
    return call(`express_send_${suffix}`, {...args, confirmationToken: prepared.confirmationToken});
  }
  const {operation, limit, pages} = input;
  const method = operation === "search-people" ? "express_search_direct_chats" : operation === "read-chat" ? "express_read_chat" : operation === "read-thread" ? "express_read_thread" : "express_list_chats";
  const args: Record<string, unknown> = {limit};
  if ("chatId" in input) args.chatId = input.chatId;
  if ("threadId" in input) args.threadId = input.threadId;
  if (operation === "search-people") args.query = input.query;
  const items: unknown[] = []; let scanned = 0; let pagesRead = 0; let truncated = false; let bytes = 0;
  for (let page = 0; page < pages; page++) {
    const result = await call(method, args); pagesRead++;
    if (!result.ok || !Array.isArray(result.items)) throw new ExpressError("INTERNAL_ERROR");
    scanned += result.items.length;
    for (const item of result.items) {
      if (operation === "search-chats" && !String(item.title ?? "").toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue;
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 200 * 1024) return {ok: true, items, count: items.length, scanned, pagesRead, truncated: true, stopped: "output_limit"};
      items.push(item); bytes += size;
    }
    truncated = Boolean(result.nextCursor || result.truncated);
    if (!result.nextCursor) break;
    args.cursor = result.nextCursor;
  }
  // Cursors are caller-bound and invalid after this invocation exits.
  return {ok: true, items, count: items.length, scanned, pagesRead, truncated};
}
export async function runAgentCommand(socket?: string) {
  const raw = await readInput();
  if (!agentRequestSchema.safeParse(raw).success) throw new ExpressError("INVALID_INPUT");
  const client = new Client({name: "express-agent-cli", version: "0.1.0"});
  const transport = new StdioClientTransport({command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve", ...(socket ? ["--socket", socket] : [])], stderr: "pipe", ...(process.env.EXPRESS_MCP_ADAPTER === "mock" ? {env: {EXPRESS_MCP_ADAPTER: "mock", ...(process.env.EXPRESS_MCP_PROFILE_DIR ? {EXPRESS_MCP_PROFILE_DIR: process.env.EXPRESS_MCP_PROFILE_DIR} : {})}} : {})});
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    const result = await agentOperation(raw, async (name, args) => {
      const response = await client.callTool({name, arguments: args});
      const text = response.content && Array.isArray(response.content) ? response.content.find((c: any) => c.type === "text") as {text?: string} | undefined : undefined;
      if (!text?.text) throw new ExpressError("INTERNAL_ERROR");
      const value = JSON.parse(text.text);
      if (response.isError || value.ok === false) {
        // Preserve only the already-sanitized server error; never retry writes.
        throw new ExpressError(value.error?.code ?? "INTERNAL_ERROR");
      }
      return value;
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { await client.close(); }
}
