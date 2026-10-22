import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { ExpressError, safeErrorBody } from "../src/errors.js";
import { createSafeLogger } from "../src/logger.js";
import { AuthManager } from "../src/session/auth.js";
import { fixture, MemoryStore } from "./session-fixtures.js";

test("default logs and structured errors cannot include untrusted sentinels", () => {
  const sentinels = [
    "SENTINEL_COOKIE",
    "SENTINEL_BEARER",
    "SENTINEL_REFRESH_TOKEN",
    "SENTINEL_CHAT_ID",
    "SENTINEL_CHAT_TITLE",
    "SENTINEL_PARTICIPANT",
    "SENTINEL_CONFIRMATION",
    "SENTINEL_MESSAGE_BODY",
    "SENTINEL_SEARCH_QUERY",
    "SENTINEL_DIRECT_DETAIL",
    "SENTINEL_FINGERPRINT",
    "SENTINEL_RAW_BROWSER_ERROR",
  ];
  let captured = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk);
      callback();
    },
  });
  const logger = createSafeLogger(destination);
  logger.info({
    operation: "synthetic_operation",
    code: "SAFE_CODE",
    count: 1,
    durationMs: 2,
  });
  const error = safeErrorBody(new ExpressError("INTERNAL_ERROR"));
  const combined = `${captured}${JSON.stringify(error)}`;
  for (const sentinel of sentinels) {
    assert.equal(combined.includes(sentinel), false);
  }
});

test("auth recovery history is capped, controlled and copied without secret-bearing failures", async () => {
  let now = 1000; let locked = true; const bundle = {...fixture(), refreshAt: null, expiresAt: null};
  const sentinels = [bundle.accessToken, bundle.refreshToken, bundle.etsToken, bundle.accountId, bundle.udid, bundle.ctsOrigin, bundle.ctsKey.secret, bundle.signing.seed, "SENTINEL_RAW_ERROR", "SENTINEL_RAW_REASON"];
  const store = new MemoryStore(bundle); const load = store.load.bind(store);
  store.load = async () => {if (locked) throw Object.assign(new Error(sentinels.join(" ")), {code: "SENTINEL_RAW_ERROR", stack: "SENTINEL_RAW_ERROR"}); return load();};
  const auth = new AuthManager(store, async () => ({kind: "permanent", code: "SENTINEL_RAW_REASON"}), () => now);
  try {
    await auth.boot;
    for (let attempt = 0; attempt < 20; attempt++) {now = auth.diagnostics().nextRetryAt!; await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);}
    const history = auth.diagnostics().authRecoveryHistory;
    assert.equal(history.length, 32);
    assert.ok(history.every((entry, index) => index === 0 || entry.timestamp >= history[index - 1]!.timestamp));
    for (const entry of history) assert.deepEqual(Object.keys(entry).sort(), ["code", "generation", "outcome", "phase", "state", "timestamp"]);
    assert.ok(history.every(entry => entry.code === "KEYCHAIN_UNAVAILABLE"));
    const original = structuredClone(history); history[0]!.timestamp = -1; history[0]!.code = "SENTINEL_RAW_ERROR"; history.pop();
    assert.deepEqual(auth.diagnostics().authRecoveryHistory, original);
    locked = false; now = auth.diagnostics().nextRetryAt!; await auth.credentials();
    await auth.refresh(); assert.equal(auth.diagnostics().lastAuthErrorCode, "UNCLASSIFIED_AUTH_ERROR");
    const encoded = JSON.stringify(auth.diagnostics());
    for (const sentinel of sentinels) assert.equal(encoded.includes(sentinel), false);
    assert.ok(auth.diagnostics().authRecoveryHistory.some(entry => entry.outcome === "revoked"));
    assert.equal(Object.hasOwn(store.value!, "authRecoveryHistory"), false);
  } finally {await auth.close();}
});

test("successful exchange and temporary-save history boundaries are completed with controlled private metadata", async () => {
  let now = 1000; let calls = 0; const bundle = {...fixture(), refreshAt: null, expiresAt: null}; const store = new MemoryStore(bundle);
  const sentinels = [bundle.accountId, bundle.udid, bundle.ctsOrigin, bundle.ctsKey.secret, "SENTINEL_NEW_ACCESS", "SENTINEL_NEW_REFRESH", "SENTINEL_RAW_REASON"];
  const auth = new AuthManager(store, async () => ++calls === 1
    ? {kind: "ok", accessToken: "SENTINEL_NEW_ACCESS", refreshToken: "SENTINEL_NEW_REFRESH", expiresIn: null}
    : {kind: "temporary", code: calls === 2 ? "EHOSTDOWN" : "SENTINEL_RAW_REASON"}, () => now);
  try {
    await auth.refresh(); await auth.refresh();
    const history = auth.diagnostics().authRecoveryHistory;
    assert.equal(history.filter(event => event.phase === "exchange" && event.outcome === "succeeded").length, 1);
    const completed = history.findIndex(event => event.phase === "result_save" && event.outcome === "succeeded");
    assert.ok(completed > 0); assert.equal(history[completed]?.code, "EHOSTDOWN");
    assert.equal(history[completed + 1]?.phase, "exchange"); assert.equal(history[completed + 1]?.outcome, "retry_scheduled");
    now = auth.diagnostics().nextRetryAt!; await auth.refresh();
    assert.ok(auth.diagnostics().authRecoveryHistory.some(event => event.phase === "result_save" && event.outcome === "succeeded" && event.code === "UNCLASSIFIED_AUTH_ERROR"));
    for (const sentinel of sentinels) assert.equal(JSON.stringify(auth.diagnostics()).includes(sentinel), false);
    assert.ok(auth.diagnostics().authRecoveryHistory.length <= 32);
  } finally {await auth.close();}
});
