import {attachmentInputSchema, readAttachmentSource, attachmentBinding, saveAttachment, attachmentMessageId, type AttachmentInput, type AttachmentSendResult} from "./attachments.js";
import { createHash } from "node:crypto";
import type {
  ExpressAdapter,
  AdapterStatus,
  ChatSummary,
  DirectChatSummary,
  VisibleMessage,
} from "./adapter/types.js";
import { boundedPage, normalizeLimit, type PageInput, type PageResult } from "./bounds.js";
import { ConfirmationStore } from "./confirmation.js";
import {
  MAX_CHAT_ID_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_CODE_POINTS,
  SELECTOR_BUNDLE_VERSION,
} from "./constants.js";
import { CursorStore } from "./cursors.js";
import { ExpressError, safeErrorBody } from "./errors.js";
import type { SafeLogger } from "./logger.js";

export interface PrepareResult {
  ok: true;
  preview: {
    chatId: string;
    text: string;
  };
  confirmationToken: string;
  expiresAt: string;
  expiresInSeconds: 120;
}

export type SendResult =
  | {
      ok: true;
      outcome: "verified";
      tokenConsumed: true;
      retryAttempted: false;
    }
  | {
      ok: false;
      outcome: "unknown";
      tokenConsumed: true;
      retryAttempted: false;
      error: ReturnType<typeof safeErrorBody>["error"];
    };

export interface SearchDirectInput extends PageInput {
  query: string;
}

export class ExpressService {
  readonly #adapter: ExpressAdapter;
  readonly #attachmentConfirmations = new ConfirmationStore();
  readonly #attachmentIds = new Map<string, {messageId: string; expiresAt: number}>();
  readonly #confirmations: ConfirmationStore;
  readonly #cursors: CursorStore;
  readonly #logger: SafeLogger;

  constructor(options: {
    adapter: ExpressAdapter;
    logger: SafeLogger;
    confirmations?: ConfirmationStore;
    cursors?: CursorStore;
  }) {
    this.#adapter = options.adapter;
    this.#logger = options.logger;
    this.#confirmations = options.confirmations ?? new ConfirmationStore();
    this.#cursors = options.cursors ?? new CursorStore();
  }

  async status(): Promise<{ ok: true; status: AdapterStatus }> {
    const started = Date.now();
    const status = await this.#adapter.status();
    this.#logger.info({
      operation: "status",
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    return { ok: true, status };
  }

  async listChats(
    input: PageInput,
  ): Promise<PageResult<ChatSummary>> {
    const started = Date.now();
    const chats = await this.#adapter.listChats();
    const result = boundedPage(chats, input, "list_chats", this.#cursors);
    this.#logger.info({
      operation: "list_chats",
      count: result.count,
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    return result;
  }

  async searchDirectChats(
    input: SearchDirectInput,
  ): Promise<PageResult<DirectChatSummary>> {
    const query = validateSearchQuery(input.query);
    const started = Date.now();
    const chats = await this.#adapter.searchDirectChats(query);
    const queryScope = createHash("sha256")
      .update(query, "utf8")
      .digest("base64url");
    const result = boundedPage(
      chats,
      {
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      },
      `search_direct_chats:${queryScope}`,
      this.#cursors,
    );
    this.#logger.info({
      operation: "search_direct_chats",
      count: result.count,
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    return result;
  }

  async readChat(
    chatId: string,
    input: PageInput,
  ): Promise<PageResult<VisibleMessage> & { mayMarkRead: true }> {
    validateChatId(chatId);
    if (this.#adapter.readChatPage) return { ...await this.#adapter.readChatPage(chatId, input, this.#cursors), mayMarkRead: true };
    const started = Date.now();
    const messages = await this.#adapter.readChat(chatId);
    const result = boundedPage(
      messages,
      input,
      `read_chat:${chatId}`,
      this.#cursors,
    );
    this.#logger.info({
      operation: "read_chat",
      count: result.count,
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    return { ...result, mayMarkRead: true };
  }

  async listThreads(chatId: string, limit?: number) {
    validateChatId(chatId);
    if (!this.#adapter.listThreads) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    return this.#adapter.listThreads(chatId, normalizeLimit(limit));
  }

  async readThread(chatId: string, threadId: string, input: PageInput) {
    validateChatId(chatId); validateChatId(threadId);
    if (!this.#adapter.readThreadPage) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    return {...await this.#adapter.readThreadPage(chatId, threadId, input, this.#cursors), parentChatId: chatId, threadId};
  }

  async getChatInfo(chatId: string) {
    validateChatId(chatId);
    if (!this.#adapter.getChatInfo) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    return this.#adapter.getChatInfo(chatId);
  }

  async prepareAttachment(input: AttachmentInput) {
    const parsed = attachmentInputSchema.safeParse(input);
    if (!parsed.success) throw new ExpressError("INVALID_INPUT");
    input = parsed.data;
    if (!this.#adapter.sendAttachment) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    const info = await this.getChatInfo(input.chatId);
    if (input.selfOnly && (info.type !== "group_chat" || !info.onlySelf)) throw new ExpressError("SELF_CHAT_REQUIRED");
    const source = await readAttachmentSource(input);
    try {
      for (const [token, record] of this.#attachmentIds) if (record.expiresAt <= Date.now()) this.#attachmentIds.delete(token);
      if (this.#attachmentIds.size >= 128) this.#attachmentIds.delete(this.#attachmentIds.keys().next().value!);
      const confirmation = this.#attachmentConfirmations.prepare(input.chatId, attachmentBinding(input, source));
      const messageId = attachmentMessageId();
      this.#attachmentIds.set(confirmation.token, {messageId, expiresAt: confirmation.expiresAt});
      return {ok: true, messageId, preview: {chatId: input.chatId, title: info.title, fileName: source.fileName, mimeType: source.mimeType, kind: source.kind, size: source.size, sha256: source.sha256, caption: input.caption, selfOnly: input.selfOnly}, confirmationToken: confirmation.token, expiresAt: new Date(confirmation.expiresAt).toISOString(), expiresInSeconds: 120};
    } finally { source.bytes.fill(0); }
  }

  async sendAttachment(input: AttachmentInput, confirmationToken: string): Promise<AttachmentSendResult> {
    const parsed = attachmentInputSchema.safeParse(input);
    if (!parsed.success) throw new ExpressError("INVALID_INPUT");
    input = parsed.data;
    if (!this.#adapter.sendAttachment) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    const source = await readAttachmentSource(input);
    try {
      this.#attachmentConfirmations.consume(confirmationToken, input.chatId, attachmentBinding(input, source));
      const messageId = this.#attachmentIds.get(confirmationToken)?.messageId;
      this.#attachmentIds.delete(confirmationToken);
      if (!messageId) throw new ExpressError("CONFIRMATION_UNKNOWN");
      try { return await this.#adapter.sendAttachment(input, source, messageId); }
      catch (error) { return {ok: false, outcome: "unknown", messageId, tokenConsumed: true, retryAttempted: false, error: safeErrorBody(error).error}; }
    } finally { source.bytes.fill(0); }
  }

  async downloadAttachment(chatId: string, messageId: string) {
    validateChatId(chatId); validateChatId(messageId);
    if (!this.#adapter.downloadAttachment) throw new ExpressError("UNSUPPORTED_PROTOCOL");
    const {bytes, metadata} = await this.#adapter.downloadAttachment(chatId, messageId);
    try { return {ok: true, chatId, messageId, ...metadata, ...await saveAttachment(bytes, metadata.fileName)}; }
    finally { bytes.fill(0); }
  }

  async prepareMessage(chatId: string, text: string): Promise<PrepareResult> {
    validateChatId(chatId);
    validateText(text);
    const started = Date.now();
    await this.#adapter.validateChatTarget(chatId);
    const confirmation = this.#confirmations.prepare(chatId, text);
    this.#logger.info({
      operation: "prepare_message",
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    return {
      ok: true,
      preview: { chatId, text },
      confirmationToken: confirmation.token,
      expiresAt: new Date(confirmation.expiresAt).toISOString(),
      expiresInSeconds: 120,
    };
  }

  async sendMessage(
    chatId: string,
    text: string,
    confirmationToken: string,
  ): Promise<SendResult> {
    validateChatId(chatId);
    validateText(text);
    if (confirmationToken.length === 0) {
      throw new ExpressError("CONFIRMATION_UNKNOWN");
    }

    this.#confirmations.consume(confirmationToken, chatId, text);
    const started = Date.now();
    let outcome: "verified" | "unknown";
    try {
      outcome = await this.#adapter.sendMessage(chatId, text);
    } catch {
      // Once a token is consumed, any adapter failure is conservatively
      // uncertain: the server cannot prove whether the single UI submit took
      // effect and must never retry it.
      outcome = "unknown";
    }
    this.#logger.info({
      operation: "send_message",
      code: outcome === "verified" ? "SEND_VERIFIED" : "SEND_OUTCOME_UNKNOWN",
      durationMs: Date.now() - started,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
    });
    if (outcome === "unknown") {
      return {
        ok: false,
        outcome: "unknown",
        tokenConsumed: true,
        retryAttempted: false,
        error: safeErrorBody(
          new ExpressError("SEND_OUTCOME_UNKNOWN"),
        ).error,
      };
    }
    return {
      ok: true,
      outcome: "verified",
      tokenConsumed: true,
      retryAttempted: false,
    };
  }

  async close(): Promise<void> {
    this.#confirmations.clear(); this.#attachmentConfirmations.clear(); this.#attachmentIds.clear(); this.#cursors.clear();
    await this.#adapter.close();
  }
}

export type ServiceApi = Pick<ExpressService, "status" | "listChats" | "searchDirectChats" | "readChat" | "listThreads" | "readThread" | "getChatInfo" | "prepareAttachment" | "sendAttachment" | "downloadAttachment" | "prepareMessage" | "sendMessage" | "close">;

export function validateChatId(chatId: string): void {
  if (chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
    throw new ExpressError("INVALID_INPUT");
  }
}

export function validateText(text: string): void {
  if (
    text.length === 0 ||
    text.length > MAX_MESSAGE_TEXT_LENGTH ||
    Buffer.byteLength(text, "utf8") > MAX_MESSAGE_TEXT_LENGTH
  ) {
    throw new ExpressError("INVALID_INPUT");
  }
}

export function validateSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (
    trimmed.length === 0 ||
    Array.from(trimmed).length > MAX_SEARCH_QUERY_CODE_POINTS ||
    Buffer.byteLength(trimmed, "utf8") > MAX_SEARCH_QUERY_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)
  ) {
    throw new ExpressError("INVALID_INPUT");
  }
  return trimmed;
}
