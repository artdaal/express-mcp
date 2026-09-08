import { randomBytes, randomUUID } from "node:crypto";
import { b64, sharedKey, signingKey } from "../src/session/crypto.js";
import { AuthBundle, SecretStore } from "../src/session/types.js";
export function fixture(now = 1_000): AuthBundle {
  return {version: 1, generation: 0, ctsOrigin: "https://chat.example.com", accountId: randomUUID(), udid: randomUUID(), accessToken: "synthetic-access", refreshToken: "synthetic-refresh", etsToken: "synthetic-ets", issuedAt: now, expiresAt: now + 60_000, refreshAt: now + 30_000, refreshPending: false, revoked: false, ctsKey: sharedKey(randomUUID(), b64(randomBytes(32))), rtsKey: sharedKey(randomUUID(), b64(randomBytes(32))), signing: signingKey(), serverPublicKey: b64(randomBytes(32))};
}
export class MemoryStore implements SecretStore {
  writes: AuthBundle[] = []; failAt = 0;
  constructor(public value: AuthBundle | null) {}
  async load() { return structuredClone(this.value); }
  async save(value: AuthBundle) { if (this.failAt === this.writes.length + 1) throw new Error("synthetic-store-failure"); this.writes.push(structuredClone(value)); this.value = structuredClone(value); }
}
