import { randomBytes } from "node:crypto";
import { ExpressError } from "./errors.js";

interface CursorRecord {
  readonly scope: string;
  readonly offset: number;
  readonly expiresAt: number;
  readonly value?: unknown;
}

export class CursorStore {
  readonly #records = new Map<string, CursorRecord>();
  readonly #randomToken: () => string;

  constructor(randomToken?: () => string) {
    this.#randomToken =
      randomToken ?? (() => randomBytes(24).toString("base64url"));
  }

  issue(scope: string, offset: number): string {
    return this.issueValue(scope, offset, offset);
  }

  clear(): void { this.#records.clear(); }

  issueValue(scope: string, value: unknown, offset = 0): string {
    for (const [key, record] of this.#records) if (record.expiresAt <= Date.now()) this.#records.delete(key);
    if (this.#records.size >= 256) this.#records.delete(this.#records.keys().next().value!);
    const token = this.#randomToken();
    this.#records.set(token, { scope, offset, value, expiresAt: Date.now() + 10 * 60_000 });
    return token;
  }

  resolveValue<T>(cursor: string, scope: string): T {
    this.resolve(cursor, scope);
    return this.#records.get(cursor)!.value as T;
  }

  resolve(cursor: string | undefined, scope: string): number {
    if (cursor === undefined) {
      return 0;
    }
    const record = this.#records.get(cursor);
    if (!record || record.scope !== scope || record.expiresAt <= Date.now()) {
      throw new ExpressError("INVALID_CURSOR");
    }
    return record.offset;
  }
}
