import test from "node:test";
import assert from "node:assert/strict";
import { AuthManager } from "../src/session/auth.js";
import { fixture, MemoryStore } from "./session-fixtures.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG } from "../src/session/types.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}

test("enrollment saving first excludes old-device refresh and credential readers", async () => {
  const old = fixture(); const enrolled = fixture(100_000); const store = new MemoryStore(old);
  const saving = gate(); const finishSave = gate(); const originalSave = store.save.bind(store);
  store.save = async value => {
    if (value.udid === enrolled.udid) { saving.release(); await finishSave.promise; }
    await originalSave(value);
  };
  let calls = 0; let readerFinished = false;
  const auth = new AuthManager(store, async () => { calls++; return {kind: "ok", accessToken: "old-rotated", refreshToken: "old-rotated", expiresIn: 60}; }, () => 100_000);
  await auth.boot;
  const install = auth.install(enrolled); await saving.promise;
  const refreshes = Array.from({length: 40}, () => auth.refresh());
  const read = auth.credentials().then(value => { readerFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(readerFinished, false); assert.equal(store.value?.udid, old.udid);
  finishSave.release(); await Promise.all([install, ...refreshes]);
  assert.equal((await read).udid, enrolled.udid); assert.equal(calls, 0);
  assert.equal(store.value?.udid, enrolled.udid); assert.equal(store.value?.accessToken, enrolled.accessToken);
  assert.equal(store.writes.length, 1); await auth.close();
});

test("refresh saving first completes before enrollment and cannot overwrite it", async () => {
  const old = fixture(); const enrolled = fixture(100_000); const store = new MemoryStore(old);
  const exchanging = gate(); const finishExchange = gate(); const changes: boolean[] = [];
  const auth = new AuthManager(store, async () => {
    exchanging.release(); await finishExchange.promise;
    return {kind: "ok", accessToken: "old-rotated", refreshToken: "old-rotated", expiresIn: 60};
  }, () => 100_000);
  auth.on("changed", event => changes.push(event.enrollment)); await auth.boot;
  const refresh = auth.refresh(); await exchanging.promise;
  const install = auth.install(enrolled);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.value?.udid, old.udid); assert.equal(store.value?.refreshPending, true); assert.equal(store.writes.length, 1);
  finishExchange.release(); await Promise.all([refresh, install]);
  assert.equal((await auth.credentials()).udid, enrolled.udid); assert.equal(store.value?.udid, enrolled.udid);
  assert.equal(store.value?.accessToken, enrolled.accessToken); assert.deepEqual(changes, [false, true]);
  assert.equal(store.writes.length, 3); await auth.close();
});

test("a wall-clock jump and 40 callers perform one rotation; durable intent precedes request", async () => {
  let now = 1_000; const store = new MemoryStore(fixture(now)); let calls = 0;
  const auth = new AuthManager(store, async old => {
    calls++; assert.equal(store.value?.refreshPending, true); assert.equal(old.refreshPending, false);
    await new Promise(resolve => setTimeout(resolve, 5)); return {kind: "ok", accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 120};
  }, () => now);
  await auth.boot; now += 3_600_000;
  const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
  assert.equal(calls, 1); assert.ok(results.every(r => r.generation === 1));
  assert.equal(store.writes.length, 2); assert.equal(store.value?.refreshToken, "rotated-refresh"); assert.equal(store.value?.refreshAt, now + 60_000);
  await auth.close();
});
test("lost refresh response and process restart never replay the old token", async () => {
  const store = new MemoryStore(fixture()); let calls = 0;
  const auth = new AuthManager(store, async () => { calls++; throw new Error("network"); }, () => 40_000);
  await assert.rejects(auth.credentials(), /AUTH_RECOVERY_REQUIRED/); await auth.close();
  const restarted = new AuthManager(store, async () => { calls++; throw new Error(); }, () => 80_000);
  await assert.rejects(restarted.credentials(), /AUTH_RECOVERY_REQUIRED/); assert.equal(calls, 1); await restarted.close();
});
test("store failure before exchange prevents request; failure after rotation enters recovery", async () => {
  for (const failAt of [1, 2]) {
    const store = new MemoryStore(fixture()); store.failAt = failAt; let calls = 0;
    const auth = new AuthManager(store, async () => { calls++; return {kind: "ok", accessToken: "new", refreshToken: "new", expiresIn: 60}; }, () => 40_000);
    await assert.rejects(auth.credentials()); assert.equal(calls, failAt === 1 ? 0 : 1);
    assert.equal(auth.diagnostics().authState, failAt === 1 ? "locked" : "recovery_required"); await auth.close();
  }
});
test("temporary retries are bounded while permanent revocation survives restart", async () => {
  let now = 40_000; let calls = 0; const store = new MemoryStore(fixture());
  const auth = new AuthManager(store, async () => { calls++; return {kind: "temporary", code: "KEYCLOAK_REFRESH_ERROR", retryAfterMs: 10_000}; }, () => now);
  await auth.credentials(); await auth.credentials(); assert.equal(calls, 1); assert.equal(store.value?.refreshPending, false);
  now = 90_000; await assert.rejects(auth.credentials(), /AUTH_RETRY_WAIT/); assert.equal(calls, 2); await auth.close();
  const permanent = new AuthManager(store, async () => ({kind: "permanent", code: "REFRESH_TOKEN_ERROR"}), () => now);
  await assert.rejects(permanent.credentials(), /REAUTH_REQUIRED/); await permanent.close();
  const restarted = new AuthManager(store, async () => { throw new Error("must not call"); }, () => now);
  await assert.rejects(restarted.credentials(), /REAUTH_REQUIRED/); assert.equal(store.value?.revoked, true); await restarted.close();
});
test("missing TTL remains unknown, refresh is driven by explicit expiry event", async () => {
  const store = new MemoryStore({...fixture(), expiresAt: null, refreshAt: null}); let calls = 0;
  const auth = new AuthManager(store, async () => { calls++; return {kind: "ok", accessToken: "new", refreshToken: "new", expiresIn: null}; }, () => 999_999);
  await auth.credentials(); assert.equal(calls, 0); await auth.refresh(); assert.equal(calls, 1); assert.equal(store.value?.refreshAt, null); await auth.close();
});
test("HTTP refresh distinguishes server outcomes and rejects redirects", async () => {
  for (const [body, code, expected] of [[{status: "error", reason: "refresh_token_error"}, 401, "permanent"], [{status: "error", reason: "keycloak_refresh_error"}, 503, "temporary"], [{oops: true}, 500, "ambiguous"], [{result: {cts_access_token: "a", refresh_token: "r", expires_in: 120}}, 200, "ok"]] as const) {
    const http = new SessionHttp(DEFAULT_CONFIG, async (_url, init) => { assert.equal(init?.redirect, "error"); return new Response(JSON.stringify(body), {status: code}); });
    assert.equal((await http.refresh(fixture())).kind, expected);
  }
  let called = false; const http = new SessionHttp(DEFAULT_CONFIG, async () => { called = true; throw new Error(); });
  await assert.rejects(http.json("https://example.com", "/api/x"), /UPSTREAM_ORIGIN_DENIED/); assert.equal(called, false);
});
