import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationStore } from "../src/confirmation.js";
import { CONFIRMATION_TTL_MS } from "../src/constants.js";
import { ExpressError } from "../src/errors.js";

function code(error: unknown, expected: string): boolean {
  return error instanceof ExpressError && error.code === expected;
}

test("confirmation is exact, expires at 120 seconds, and is single-use", () => {
  let now = 1_000;
  let sequence = 0;
  const store = new ConfirmationStore({
    now: () => now,
    randomToken: () => `opaque-${sequence++}`,
  });
  const prepared = store.prepare("chat-a", " exact text ");
  assert.equal(prepared.expiresAt, now + CONFIRMATION_TTL_MS);
  assert.throws(
    () => store.consume(prepared.token, "chat-a", "exact text"),
    (error: unknown) => code(error, "CONFIRMATION_MISMATCH"),
  );
  store.consume(prepared.token, "chat-a", " exact text ");
  assert.throws(
    () => store.consume(prepared.token, "chat-a", " exact text "),
    (error: unknown) => code(error, "CONFIRMATION_UNKNOWN"),
  );

  const canonical = store.prepare("chat-a", "\u00e9");
  assert.throws(
    () => store.consume(canonical.token, "chat-a", "e\u0301"),
    (error: unknown) => code(error, "CONFIRMATION_MISMATCH"),
  );

  const expiring = store.prepare("chat-a", "synthetic");
  now += CONFIRMATION_TTL_MS;
  assert.throws(
    () => store.consume(expiring.token, "chat-a", "synthetic"),
    (error: unknown) => code(error, "CONFIRMATION_EXPIRED"),
  );
});

test("confirmation state is process-memory-only", () => {
  const first = new ConfirmationStore({
    randomToken: () => "process-local-token",
  });
  first.prepare("chat-a", "synthetic");
  const restarted = new ConfirmationStore();
  assert.throws(
    () =>
      restarted.consume("process-local-token", "chat-a", "synthetic"),
    (error: unknown) => code(error, "CONFIRMATION_UNKNOWN"),
  );
});
