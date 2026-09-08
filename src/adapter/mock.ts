import { randomBytes } from "node:crypto";
import { SELECTOR_BUNDLE_VERSION } from "../constants.js";
import { ExpressError } from "../errors.js";
import type {
  ExpressAdapter,
  AdapterStatus,
  ChatSummary,
  DirectChatSummary,
  SendOutcome,
  VisibleMessage,
} from "./types.js";

interface MockDirectTarget {
  summary: DirectChatSummary;
  capturedFingerprint: string;
  rowIndex: number;
}

const MAX_MOCK_DIRECT_TARGETS = 200;

export class MockExpressAdapter implements ExpressAdapter {
  readonly chats: ChatSummary[];
  readonly directChats: ReadonlyArray<{
    title: string;
    detail?: string;
  }>;
  readonly messages: ReadonlyMap<string, VisibleMessage[]>;
  readonly sendOutcome: SendOutcome;
  readonly #directTargets = new Map<string, MockDirectTarget>();
  #directRows: Array<{ fingerprint: string; connected: boolean }> = [];
  readonly #randomToken: () => string;
  sendCalls = 0;
  searchCalls = 0;
  listCalls = 0;
  readCalls = 0;
  validateCalls = 0;
  lastSearchQuery?: string;

  constructor(options?: {
    chats?: ChatSummary[];
    directChats?: ReadonlyArray<{
      title: string;
      detail?: string;
    }>;
    messages?: ReadonlyMap<string, VisibleMessage[]>;
    sendOutcome?: SendOutcome;
    randomToken?: () => string;
  }) {
    this.chats =
      options?.chats ??
      Array.from({ length: 75 }, (_, index) => ({
        chatId: `synthetic-chat-${index + 1}`,
        title: `Synthetic chat ${index + 1}`,
        timestamp: "12:00",
        unreadCount: 0,
      }));
    this.directChats =
      options?.directChats ??
      Array.from({ length: 75 }, (_, index) => ({
        title: `Synthetic contact ${index + 1}`,
        ...(index % 2 === 0
          ? { detail: `Synthetic detail ${index + 1}` }
          : {}),
      }));
    this.messages =
      options?.messages ??
      new Map(
        this.chats.map((chat) => [
          chat.chatId,
          Array.from({ length: 75 }, (_, index) => ({
            messageId: `synthetic-message-${index + 1}`,
            text: `Synthetic message ${index + 1}`,
            timestamp: "12:00",
          })),
        ]),
      );
    this.sendOutcome = options?.sendOutcome ?? "verified";
    this.#randomToken =
      options?.randomToken ??
      (() => randomBytes(24).toString("base64url"));
  }

  async status(): Promise<AdapterStatus> {
    return {
      profileReady: true,
      authentication: "authenticated",
      officialOrigin: true,
      selectorCompatible: true,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
      guidance: "Synthetic mock adapter is ready.",
    };
  }

  async listChats(): Promise<ChatSummary[]> {
    this.listCalls += 1;
    this.#directTargets.clear();
    this.#directRows = [];
    return this.chats;
  }

  async searchDirectChats(query: string): Promise<DirectChatSummary[]> {
    this.searchCalls += 1;
    this.lastSearchQuery = query;
    this.#directTargets.clear();
    this.#directRows = [];
    const results = this.directChats.map((contact, rowIndex) => {
      const result: DirectChatSummary = {
        chatId: `direct_${this.#randomToken()}`,
        title: contact.title,
        ...(contact.detail ? { detail: contact.detail } : {}),
        type: "direct",
      };
      const fingerprint = JSON.stringify([
        result.title,
        result.detail ?? "",
      ]);
      this.#directRows.push({ fingerprint, connected: true });
      this.#directTargets.set(result.chatId, {
        summary: result,
        capturedFingerprint: fingerprint,
        rowIndex,
      });
      while (this.#directTargets.size > MAX_MOCK_DIRECT_TARGETS) {
        const oldest = this.#directTargets.keys().next().value as
          | string
          | undefined;
        if (!oldest) {
          break;
        }
        this.#directTargets.delete(oldest);
      }
      return result;
    });
    return results;
  }

  async readChat(chatId: string): Promise<VisibleMessage[]> {
    this.readCalls += 1;
    await this.validateChatTarget(chatId);
    if (this.#directTargets.has(chatId)) {
      return [
        {
          messageId: "synthetic-direct-message",
          text: "Synthetic direct message",
        },
      ];
    }
    return this.messages.get(chatId) ?? [];
  }

  async validateChatTarget(chatId: string): Promise<void> {
    this.validateCalls += 1;
    if (this.chats.some((chat) => chat.chatId === chatId)) {
      return;
    }
    const target = this.#directTargets.get(chatId);
    const currentRow = target
      ? this.#directRows[target.rowIndex]
      : undefined;
    const uniqueFingerprintMatches = target
      ? this.#directRows.filter(
          (row) =>
            row.connected &&
            row.fingerprint === target.capturedFingerprint,
        ).length
      : 0;
    if (
      !target ||
      !currentRow?.connected ||
      currentRow.fingerprint !== target.capturedFingerprint ||
      uniqueFingerprintMatches !== 1
    ) {
      this.#directTargets.delete(chatId);
      throw new ExpressError("CHAT_NOT_TARGETABLE");
    }
  }

  recycleDirectTarget(chatId: string): void {
    const target = this.#directTargets.get(chatId);
    if (target) {
      const currentRow = this.#directRows[target.rowIndex];
      if (currentRow) {
        currentRow.fingerprint = `${currentRow.fingerprint}:recycled`;
      }
    }
  }

  detachDirectTarget(chatId: string): void {
    const target = this.#directTargets.get(chatId);
    if (target) {
      const currentRow = this.#directRows[target.rowIndex];
      if (currentRow) {
        currentRow.connected = false;
      }
    }
  }

  directTargetCount(): number {
    return this.#directTargets.size;
  }

  async sendMessage(
    chatId: string,
    _text: string,
  ): Promise<SendOutcome> {
    await this.validateChatTarget(chatId);
    this.sendCalls += 1;
    return this.sendOutcome;
  }

  async close(): Promise<void> {
    this.#directTargets.clear();
    this.#directRows = [];
  }
}
