import { randomBytes, timingSafeEqual } from "node:crypto";
import { CONFIRMATION_TTL_MS } from "./constants.js";
import { ExpressError } from "./errors.js";

interface ConfirmationRecord {
  readonly chatId: Buffer;
  readonly text: Buffer;
  readonly expiresAt: number;
}

export interface PreparedConfirmation {
  token: string;
  expiresAt: number;
}

export class ConfirmationStore {
  readonly #records = new Map<string, ConfirmationRecord>();
  readonly #now: () => number;
  readonly #randomToken: () => string;

  constructor(options?: {
    now?: () => number;
    randomToken?: () => string;
  }) {
    this.#now = options?.now ?? Date.now;
    this.#randomToken =
      options?.randomToken ?? (() => randomBytes(32).toString("base64url"));
  }

  prepare(chatId: string, text: string): PreparedConfirmation {
    for (const [key, record] of this.#records) if (record.expiresAt <= this.#now()) this.#records.delete(key);
    if (this.#records.size >= 128) this.#records.delete(this.#records.keys().next().value!);
    const token = this.#randomToken();
    const expiresAt = this.#now() + CONFIRMATION_TTL_MS;
    this.#records.set(token, {
      chatId: Buffer.from(chatId, "utf8"),
      text: Buffer.from(text, "utf8"),
      expiresAt,
    });
    return { token, expiresAt };
  }

  clear(): void {
    for (const record of this.#records.values()) { record.text.fill(0); record.chatId.fill(0); }
    this.#records.clear();
  }

  consume(token: string, chatId: string, text: string): void {
    const record = this.#records.get(token);
    if (!record) {
      throw new ExpressError("CONFIRMATION_UNKNOWN");
    }
    if (this.#now() >= record.expiresAt) {
      this.#records.delete(token);
      throw new ExpressError("CONFIRMATION_EXPIRED");
    }

    const chatBytes = Buffer.from(chatId, "utf8");
    const textBytes = Buffer.from(text, "utf8");
    const chatMatches =
      chatBytes.length === record.chatId.length &&
      timingSafeEqual(chatBytes, record.chatId);
    const textMatches =
      textBytes.length === record.text.length &&
      timingSafeEqual(textBytes, record.text);
    if (!chatMatches || !textMatches) {
      throw new ExpressError("CONFIRMATION_MISMATCH");
    }

    // Atomic from the JavaScript event loop's perspective and deliberately
    // before the caller can start the first send-side UI action.
    this.#records.delete(token);
  }
}
