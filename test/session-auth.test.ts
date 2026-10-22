import test from "node:test";
import assert from "node:assert/strict";
import { AuthManager } from "../src/session/auth.js";
import { fixture, MemoryStore } from "./session-fixtures.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG, parseBundle, SessionError } from "../src/session/types.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

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
    assert.equal(auth.diagnostics().authState, "locked"); await auth.close();
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

test("HTTP refresh retries only proven no-transmission leaves, including nested aggregates", async () => {
  const coded = (code: string, extra = {}) => Object.assign(new Error("synthetic secret-bearing failure"), {code}, extra);
  const cases: [unknown, string | null][] = [
    [coded("ENOTFOUND"), "ENOTFOUND"], [coded("EAI_AGAIN"), "EAI_AGAIN"], [coded("ECONNREFUSED"), "ECONNREFUSED"],
    [new TypeError("fetch failed", {cause: coded("UND_ERR_CONNECT_TIMEOUT")}), "UND_ERR_CONNECT_TIMEOUT"],
    [coded("ETIMEDOUT", {syscall: "connect"}), "REFRESH_CONNECT_TIMEOUT"],
    [coded("ENETUNREACH", {syscall: "connect"}), "ENETUNREACH"], [coded("EHOSTUNREACH", {syscall: "connect"}), "EHOSTUNREACH"],
    [coded("ENETDOWN", {syscall: "connect"}), "ENETDOWN"], [coded("EHOSTDOWN", {syscall: "connect"}), "EHOSTDOWN"],
    [coded("ENOTFOUND", {syscall: "getaddrinfo"}), "ENOTFOUND"], [coded("EAI_AGAIN", {syscall: "getaddrinfo"}), "EAI_AGAIN"],
    [coded("ECONNREFUSED", {syscall: "connect", cause: coded("ENOTFOUND", {syscall: "getaddrinfo"})}), "ECONNREFUSED"],
    [new TypeError("fetch failed", {cause: new AggregateError([coded("ENOTFOUND"), new AggregateError([coded("ECONNREFUSED")])])}), "REFRESH_CONNECT_FAILED"],
    [new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]), "ECONNREFUSED"],
    [coded("ECONNRESET"), null], [coded("ETIMEDOUT"), null], [coded("UND_ERR_HEADERS_TIMEOUT"), null],
    [new DOMException("synthetic", "AbortError"), null], [new DOMException("synthetic", "TimeoutError"), null],
    [new AggregateError([coded("ENOTFOUND"), coded("ECONNRESET")]), null], [new AggregateError([]), null],
    [new Error("ENOTFOUND before HTTP"), null], [coded("UNKNOWN", {cause: coded("ENOTFOUND")}), null],
    [Object.assign(new DOMException("synthetic", "AbortError"), {cause: coded("ECONNREFUSED")}), null],
    [coded("ENETUNREACH"), null], [coded("EHOSTUNREACH", {syscall: "send"}), null],
    [coded("ENETDOWN"), null], [coded("EHOSTDOWN", {syscall: "read"}), null],
    [coded("ECONNREFUSED", {syscall: "read"}), null], [coded("ENOTFOUND", {syscall: "write"}), null],
    [coded("ECONNREFUSED", {cause: coded("ECONNRESET")}), null], [coded("ECONNREFUSED", {cause: new Error("unknown outcome")}), null],
    [Object.assign(new AggregateError([coded("ENOTFOUND")]), {name: "AbortError"}), null],
    [Object.assign(new AggregateError([coded("ECONNREFUSED")]), {name: "TimeoutError"}), null],
    [Object.assign(new AggregateError([coded("ENOTFOUND")]), {code: "ECONNRESET"}), null],
    [Object.assign(new AggregateError([coded("ENOTFOUND")]), {code: "ETIMEDOUT"}), null],
    [Object.assign(new AggregateError([coded("ENOTFOUND")]), {code: "UNKNOWN"}), null],
    [new AggregateError([coded("ENOTFOUND")], "synthetic", {cause: coded("ECONNRESET")}), null],
    [Object.assign(new AggregateError([coded("ENOTFOUND")]), {syscall: "read"}), null],
  ];
  // Match NodeAggregateError's native summary: first leaf code, no syscall.
  for (const code of ["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "ETIMEDOUT"]) {
    const aggregate = Object.assign(new AggregateError([coded(code, {syscall: "connect"}), coded(code, {syscall: "connect"})]), {code});
    cases.push([aggregate, code === "ETIMEDOUT" ? "REFRESH_CONNECT_TIMEOUT" : code]);
    cases.push([Object.assign(new AggregateError([coded(code, {syscall: "connect"}), coded("ECONNRESET")]), {code}), null]);
  }
  const causeCycle = coded("ECONNREFUSED"); Object.assign(causeCycle, {cause: causeCycle}); cases.push([causeCycle, null]);
  const cyclic = new AggregateError([coded("ECONNREFUSED")]); cyclic.errors.push(cyclic); cases.push([cyclic, null]);
  for (const [error, code] of cases) {
    const result = await new SessionHttp(DEFAULT_CONFIG, async () => { throw error; }).refresh(fixture());
    assert.deepEqual(result, code ? {kind: "temporary", code} : {kind: "ambiguous", code: "REFRESH_RESPONSE_LOST"});
  }
});

test("received but lost, malformed, incomplete or invalid-TTL refresh responses stay ambiguous", async () => {
  const replies = [
    new Response("{broken"),
    new Response(JSON.stringify({result: {cts_access_token: "", refresh_token: "r"}})),
    new Response(JSON.stringify({result: {cts_access_token: "a"}})),
    ...[0, -1, "60", null, Number.MAX_VALUE].map(expires_in => new Response(JSON.stringify({result: {cts_access_token: "a", refresh_token: "r", expires_in}}))),
    ...["cts_access_token", "refresh_token"].map(field => new Response(JSON.stringify({result: {cts_access_token: "a", refresh_token: "r", [field]: "s".repeat(64 * 1024 + 1)}}))),
    new Response(JSON.stringify({status: "error", reason: "unrecognized_secret"}), {status: 503}),
    new Response(new ReadableStream({start(controller) {controller.error(new Error("lost body"));}})),
  ];
  for (const response of replies) assert.equal((await new SessionHttp(DEFAULT_CONFIG, async () => response).refresh(fixture())).kind, "ambiguous");
});

test("the running timer retries a no-send exchange with capped backoff and 40 concurrent callers", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 40_000; let calls = 0; const store = new MemoryStore(fixture()); const exchanging = gate(); const finish = gate();
  const auth = new AuthManager(store, async () => {
    calls++;
    if (calls <= 10) return {kind: "temporary", code: "ENOTFOUND", retryAfterMs: calls === 10 ? 999_999 : 0};
    exchanging.release(); await finish.promise; return {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: 120};
  }, () => now);
  try {
    await auth.boot; auth.start(); t.mock.timers.tick(5000); await flush();
    assert.equal(calls, 1); assert.equal(store.value?.generation, 0);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const due = auth.diagnostics().nextRetryAt!;
      const base = attempt === 10 ? 300_000 : 1000 * 2 ** Math.min(attempt, 8);
      assert.ok(due - now >= base, `attempt ${attempt} must wait at least ${base}ms`);
      assert.ok(due - now <= Math.min(300_000, base + 499), `attempt ${attempt} exceeds its jitter range`);
      now = due - 1; t.mock.timers.tick(5000); await flush();
      await assert.rejects(auth.refresh(), /AUTH_RETRY_WAIT/); assert.equal(calls, attempt);
      now = due; t.mock.timers.tick(5000);
      if (attempt < 10) { await flush(); assert.equal(calls, attempt + 1); }
    }
    await exchanging.promise;
    const readers = Array.from({length: 40}, () => auth.credentials());
    const explicit = auth.refresh(); t.mock.timers.tick(5000); await flush(); assert.equal(calls, 11);
    finish.release(); const bundles = await Promise.all(readers); await explicit;
    assert.ok(bundles.every(bundle => bundle.generation === 1 && bundle.refreshToken === "new-r"));
    assert.equal(store.value?.generation, 1); assert.equal(auth.diagnostics().nextRetryAt, null);
  } finally {finish.release(); await auth.close();}
});

test("the running timer restores a locked Keychain and preserves missing/revoked/pending disk states", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  for (const expected of ["ready", "missing", "reauth_required", "recovery_required"] as const) {
    let now = 1000; let loads = 0; let calls = 0; let available = false; let changes = 0;
    const value = expected === "missing" ? null : {...fixture(), revoked: expected === "reauth_required", refreshPending: expected === "recovery_required"};
    const store = new MemoryStore(value); const originalLoad = store.load.bind(store);
    store.load = async () => {loads++; if (!available) throw new Error("locked"); return originalLoad();};
    const auth = new AuthManager(store, async () => {calls++; throw new Error("must not exchange");}, () => now);
    auth.on("changed", () => changes++);
    try {
      await auth.boot; assert.equal(auth.diagnostics().authState, "locked"); auth.start();
      const due = auth.diagnostics().nextRetryAt!; now = due - 1; t.mock.timers.tick(5000); await flush(); assert.equal(loads, 1);
      available = true; now = due; t.mock.timers.tick(5000); await flush();
      assert.equal(loads, 2); assert.equal(auth.diagnostics().authState, expected); assert.equal(changes, expected === "ready" ? 1 : 0);
      if (expected !== "ready") await assert.rejects(auth.credentials());
      assert.equal(calls, 0);
    } finally {await auth.close();}
  }
});

test("a failed pre-exchange fence may have written: only this process can safely resume", async () => {
  let now = 40_000; let calls = 0; let loads = 0; let saves = 0; const store = new MemoryStore(fixture());
  const load = store.load.bind(store); store.load = async () => {loads++; return load();};
  const save = store.save.bind(store); store.save = async value => {saves++; await save(value); if (saves === 1) throw new Error("written then locked");};
  const auth = new AuthManager(store, async previous => {
    calls++; assert.equal(previous.refreshPending, false); assert.equal(store.value?.refreshPending, true);
    return {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: 120};
  }, () => now);
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(calls, 0); assert.equal(store.value?.refreshPending, true);
    const restarted = new AuthManager(store, async () => {calls++; throw new Error();}, () => now);
    await assert.rejects(restarted.credentials(), /AUTH_RECOVERY_REQUIRED/); await restarted.close();
    const due = auth.diagnostics().nextRetryAt!; now = due - 1; await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(saves, 1);
    now = due; const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.equal(calls, 1); assert.equal(saves, 3); assert.equal(loads, 2);
    assert.ok(results.every(value => value.generation === 1));
  } finally {await auth.close();}
});

test("final-save recovery retains the exact replacement, never reloads or exchanges, and remains crash-fenced", async () => {
  let now = 40_000; let calls = 0; let loads = 0; let saves = 0; let unavailable = true; let changed = 0;
  const store = new MemoryStore(fixture()); const attempted: object[] = [];
  const load = store.load.bind(store); store.load = async () => {loads++; return load();};
  const save = store.save.bind(store); store.save = async value => {
    saves++; if (!value.refreshPending) {attempted.push(structuredClone(value)); if (unavailable) throw new Error("save locked");}
    await save(value);
  };
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: 120};}, () => now);
  auth.on("changed", () => changed++);
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(store.value?.refreshPending, true); assert.equal(auth.diagnostics().generation, 0);
    const restarted = new AuthManager(store, async () => {calls++; throw new Error();}, () => now);
    await assert.rejects(restarted.credentials(), /AUTH_RECOVERY_REQUIRED/); await restarted.close();
    for (let retry = 0; retry < 3; retry++) {
      const due = auth.diagnostics().nextRetryAt!; const base = 1000 * 2 ** (retry + 1);
      assert.ok(due - now >= base && due - now <= base + 499);
      now = due - 1; await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(saves, retry + 2);
      now = due; await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);
    }
    unavailable = false; now = auth.diagnostics().nextRetryAt!;
    const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.ok(results.every(value => value.generation === 1 && value.refreshToken === "new-r"));
    assert.equal(calls, 1); assert.equal(loads, 2); assert.equal(changed, 1);
    assert.equal(attempted.length, 5); assert.ok(attempted.every(value => JSON.stringify(value) === JSON.stringify(attempted[0])));
    assert.equal(auth.diagnostics().lastAuthenticatedRequestAt, 40_000);
  } finally {await auth.close();}
});

test("enrollment supersedes a pending replacement only after a successful durable install", async () => {
  for (const failEnrollment of [false, true]) {
    let now = 40_000; let calls = 0; let failReplacement = true; const old = fixture(); const enrolled = fixture(40_000);
    const store = new MemoryStore(old); const save = store.save.bind(store);
    store.save = async value => {
      if (value.udid === enrolled.udid && failEnrollment) throw new Error("enrollment save failed");
      if (value.udid === old.udid && value.generation === 1 && failReplacement) throw new Error("replacement save failed");
      await save(value);
    };
    const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now);
    try {
      await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);
      if (failEnrollment) await assert.rejects(auth.install(enrolled), /enrollment save failed/);
      else await auth.install(enrolled);
      failReplacement = false; now = auth.diagnostics().nextRetryAt ?? now;
      const result = await auth.credentials();
      assert.equal(result.udid, failEnrollment ? old.udid : enrolled.udid); assert.equal(calls, 1);
      assert.equal(result.refreshToken, failEnrollment ? "retained-r" : enrolled.refreshToken);
      assert.equal(store.value?.udid, result.udid);
    } finally {await auth.close();}
  }
});

test("pending-save recovery and queued expiry cannot overwrite a saving enrollment", async () => {
  let now = 40_000; let calls = 0; let failReplacement = true; const old = fixture(); const enrolled = fixture(40_000);
  const store = new MemoryStore(old); const save = store.save.bind(store); const saving = gate(); const finish = gate();
  store.save = async value => {
    if (value.udid === old.udid && value.generation === 1 && failReplacement) throw new Error("save failed");
    if (value.udid === enrolled.udid) {saving.release(); await finish.promise;}
    await save(value);
  };
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now);
  try {
    await assert.rejects(auth.credentials()); now = auth.diagnostics().nextRetryAt!; failReplacement = false;
    const install = auth.install(enrolled); await saving.promise;
    const expiry = Promise.all(Array.from({length: 40}, () => auth.refresh())); const read = auth.credentials();
    finish.release(); await install; await expiry;
    assert.equal((await read).udid, enrolled.udid); assert.equal(calls, 1); assert.equal(store.value?.accessToken, enrolled.accessToken);
  } finally {finish.release(); await auth.close();}
});

test("revocation persistence failure retries only the terminal save, including unknown durable outcome", async () => {
  let now = 40_000; let calls = 0; let fail = true; const store = new MemoryStore(fixture()); const save = store.save.bind(store);
  store.save = async value => {await save(value); if (value.revoked && fail) throw new Error("written then error");};
  const auth = new AuthManager(store, async () => {calls++; return {kind: "permanent", code: "OPENID_OFFLINE_SESSION_INVALID"};}, () => now);
  try {
    await assert.rejects(auth.credentials(), /REAUTH_REQUIRED/); assert.equal(auth.diagnostics().authState, "reauth_required"); assert.equal(store.value?.revoked, true);
    now = auth.diagnostics().nextRetryAt!; await assert.rejects(auth.credentials(), /REAUTH_REQUIRED/); assert.equal(calls, 1);
    fail = false; now = auth.diagnostics().nextRetryAt!; await assert.rejects(auth.credentials(), /REAUTH_REQUIRED/);
    await assert.rejects(auth.refresh(), /REAUTH_REQUIRED/); assert.equal(calls, 1);
  } finally {await auth.close();}
});

test("temporary result-save recovery clears only its exact fence before scheduling another exchange", async () => {
  let now = 40_000; let calls = 0; let fail = true; const store = new MemoryStore(fixture()); const save = store.save.bind(store);
  store.save = async value => {if (!value.refreshPending && fail) throw new Error("save failed"); await save(value);};
  const auth = new AuthManager(store, async () => {calls++; return {kind: "temporary", code: "KEYCLOAK_REFRESH_ERROR"};}, () => now);
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(store.value?.refreshPending, true);
    fail = false; now = auth.diagnostics().nextRetryAt!; await auth.credentials();
    assert.equal(calls, 1); assert.equal(store.value?.refreshPending, false); assert.equal(auth.diagnostics().authState, "retry_wait");
  } finally {await auth.close();}
});

test("unknown TTL also retries a temporary explicit refresh through the running timer", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let calls = 0; const store = new MemoryStore({...fixture(), expiresAt: null, refreshAt: null});
  const auth = new AuthManager(store, async () => ++calls === 1 ? {kind: "temporary", code: "KEYCLOAK_REFRESH_ERROR"} : {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: null}, () => now);
  try {
    await auth.refresh(); auth.start(); now = auth.diagnostics().nextRetryAt!; t.mock.timers.tick(5000); await flush();
    assert.equal(calls, 2); assert.equal(auth.diagnostics().authState, "ready"); assert.equal(store.value?.expiresAt, null);
  } finally {await auth.close();}
});

test("closure stops recovery timers and suppresses credentials and change events from an in-flight save", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 40_000; let calls = 0; const store = new MemoryStore(fixture()); const save = store.save.bind(store); const saving = gate(); const finish = gate(); let changes = 0;
  store.save = async value => {if (!value.refreshPending) {saving.release(); await finish.promise;} await save(value);};
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: 120};}, () => now);
  auth.on("changed", () => changes++); await auth.boot; auth.start();
  const reading = assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/); await saving.promise;
  const closing = auth.close(); finish.release(); await reading; await closing;
  now += 1_000_000; t.mock.timers.tick(1_000_000); await flush(); auth.start(); t.mock.timers.tick(5000); await flush();
  await assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/); await assert.rejects(auth.refresh(), /BROKER_UNAVAILABLE/);
  assert.equal(calls, 1); assert.equal(changes, 0);
});

test("a final save that wrote before throwing is retried exactly without a second generation", async () => {
  let now = 40_000; let calls = 0; let fail = true; const store = new MemoryStore(fixture()); const save = store.save.bind(store);
  const attempted: object[] = [];
  store.save = async value => {
    await save(value);
    if (value.generation === 1) {attempted.push(structuredClone(value)); if (fail) throw new Error("written then error");}
  };
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "new-a", refreshToken: "new-r", expiresIn: 120};}, () => now);
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(store.value?.generation, 1); assert.equal(auth.diagnostics().generation, 0);
    fail = false; now = auth.diagnostics().nextRetryAt!; const bundle = await auth.credentials();
    assert.equal(bundle.generation, 1); assert.equal(calls, 1); assert.deepEqual(attempted[0], attempted[1]);
  } finally {await auth.close();}
});

test("timers and repeated callers never replay ambiguous or permanently revoked exchanges", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  for (const permanent of [false, true]) {
    let now = 40_000; let calls = 0; const store = new MemoryStore(fixture());
    const auth = new AuthManager(store, async () => {calls++; return permanent ? {kind: "permanent", code: "REFRESH_TOKEN_ERROR"} : {kind: "ambiguous", code: "REFRESH_RESPONSE_LOST"};}, () => now);
    try {
      await assert.rejects(auth.credentials()); auth.start(); now += 1_000_000; t.mock.timers.tick(1_000_000); await flush();
      await Promise.all(Array.from({length: 40}, () => assert.rejects(auth.credentials()))); await assert.rejects(auth.refresh());
      assert.equal(calls, 1); assert.equal(auth.diagnostics().nextRetryAt, null);
    } finally {await auth.close();}
  }
});

test("closing during the pre-exchange fence stops the HTTP request", async () => {
  let calls = 0; const store = new MemoryStore(fixture()); const save = store.save.bind(store); const saving = gate(); const finish = gate();
  store.save = async value => {saving.release(); await finish.promise; await save(value);};
  const auth = new AuthManager(store, async () => {calls++; throw new Error("must not send");}, () => 40_000);
  const reading = assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/); await saving.promise;
  const closing = auth.close(); finish.release(); await reading; await closing;
  assert.equal(calls, 0); assert.equal(store.value?.refreshPending, true);
});

test("immediate shutdown handles the queued boot rejection without loading credentials", async () => {
  let loads = 0; const store = new MemoryStore(fixture()); store.load = async () => {loads++; throw new Error("must not load");};
  const auth = new AuthManager(store, async () => {throw new Error("must not send");});
  await auth.close(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(auth.boot, /BROKER_UNAVAILABLE/); await assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/);
  assert.equal(loads, 0);
});

test("an enrollment that writes before throwing is reconciled before the retained old replacement can save", async () => {
  let now = 40_000; let calls = 0; let oldSaves = 0; const old = fixture(); const enrolled = {...fixture(now), refreshAt: null, expiresAt: null};
  const store = new MemoryStore(old); const save = store.save.bind(store); const changes: boolean[] = [];
  store.save = async value => {
    if (value.udid === old.udid && value.generation === 1) {oldSaves++; throw new Error("replacement locked");}
    await save(value);
    if (value.udid === enrolled.udid) throw new Error("enrollment written then error");
  };
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now);
  auth.on("changed", event => changes.push(event.enrollment));
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); now = auth.diagnostics().nextRetryAt!;
    await auth.install(enrolled);
    const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.ok(results.every(value => value.udid === enrolled.udid));
    assert.equal(store.value?.udid, enrolled.udid); assert.equal(oldSaves, 1); assert.equal(calls, 1); assert.deepEqual(changes, [true]);
  } finally {await auth.close();}
});

test("unreadable enrollment reconciliation suspends old saves and queued expiry until the durable outcome is known", async () => {
  for (const wrote of [false, true]) {
    let now = 40_000; let calls = 0; let loads = 0; let oldSaves = 0; let unreadable = false; let failReplacement = true;
    const old = fixture(); const enrolled = {...fixture(now), refreshAt: null, expiresAt: null};
    const store = new MemoryStore(old); const save = store.save.bind(store); const load = store.load.bind(store); const saving = gate(); const finish = gate(); const changes: boolean[] = [];
    store.load = async () => {loads++; if (unreadable) throw new Error("load locked"); return load();};
    store.save = async value => {
      if (value.udid === old.udid && value.generation === 1) {oldSaves++; if (failReplacement) throw new Error("replacement locked");}
      if (value.udid === enrolled.udid) {
        saving.release(); await finish.promise; unreadable = true;
        if (wrote) await save(value);
        throw new Error("enrollment save failed");
      }
      await save(value);
    };
    const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now);
    auth.on("changed", event => changes.push(event.enrollment));
    try {
      await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); now = auth.diagnostics().nextRetryAt!;
      const installing = assert.rejects(auth.install(enrolled), /enrollment save failed/); await saving.promise;
      const expiry = Promise.all(Array.from({length: 40}, () => auth.refresh()));
      const reading = assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);
      finish.release(); await installing; await expiry; await reading; failReplacement = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const due = auth.diagnostics().nextRetryAt!; const before = loads;
        now = due - 1; await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(loads, before);
        now = due; await Promise.all(Array.from({length: 40}, () => assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/)));
        assert.equal(loads, before + 1); assert.equal(oldSaves, 1); assert.equal(calls, 1);
        assert.equal(store.value?.udid, wrote ? enrolled.udid : old.udid);
      }
      unreadable = false; now = auth.diagnostics().nextRetryAt!;
      if (!wrote) await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); // Reconciliation alone never overwrites the disk.
      const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
      assert.ok(results.every(value => value.udid === (wrote ? enrolled.udid : old.udid)));
      assert.equal(store.value?.udid, wrote ? enrolled.udid : old.udid); assert.equal(calls, 1);
      assert.equal(oldSaves, wrote ? 1 : 2); assert.deepEqual(changes, [wrote]);
      if (!wrote) assert.equal(results[0]?.refreshToken, "retained-r");
    } finally {finish.release(); await auth.close();}
  }
});

test("close drains the known HTTP replacement save while suppressing credentials, events and later work", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  for (const failSave of [false, true]) {
    let now = 40_000; let calls = 0; let saves = 0; let changes = 0; const store = new MemoryStore(fixture()); const save = store.save.bind(store);
    const exchanging = gate(); const finish = gate();
    store.save = async value => {saves++; parseBundle(value); if (!value.refreshPending && failSave) throw new Error("final save locked"); await save(value);};
    const auth = new AuthManager(store, async () => {calls++; exchanging.release(); await finish.promise; return {kind: "ok", accessToken: "drained-a", refreshToken: "drained-r", expiresIn: 120};}, () => now);
    auth.on("changed", () => changes++); auth.start();
    try {
      const reading = assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/); await exchanging.promise;
      let closed = false; const closing = auth.close().then(() => {closed = true;}); await flush(); assert.equal(closed, false);
      finish.release(); await reading; await closing;
      assert.equal(saves, 2); assert.equal(calls, 1); assert.equal(changes, 0);
      assert.equal(store.value?.refreshPending, failSave); assert.equal(store.value?.generation, failSave ? 0 : 1);
      if (!failSave) assert.equal(store.value?.refreshToken, "drained-r");
      now += 1_000_000; t.mock.timers.tick(1_000_000); await flush(); await assert.rejects(auth.credentials(), /BROKER_UNAVAILABLE/);
      assert.equal(calls, 1); assert.equal(saves, 2);
      const restarted = new AuthManager(store, async () => {throw new Error("must not exchange");}, () => 40_000);
      try {if (failSave) await assert.rejects(restarted.credentials(), /AUTH_RECOVERY_REQUIRED/); else assert.equal((await restarted.credentials()).refreshToken, "drained-r");}
      finally {await restarted.close();}
    } finally {finish.release(); await auth.close();}
  }
});

test("unpersistable replacements remain terminal ambiguous against the actual bundle schema", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  const invalid = [
    {accessToken: "s".repeat(64 * 1024 + 1), refreshToken: "r", expiresIn: 60, now: 40_000},
    {accessToken: "a", refreshToken: "s".repeat(64 * 1024 + 1), expiresIn: 60, now: 40_000},
    {accessToken: "a", refreshToken: "r", expiresIn: Number.MAX_VALUE, now: 40_000},
    {accessToken: "a", refreshToken: "r", expiresIn: 1e305, now: Number.MAX_VALUE},
  ];
  for (const value of invalid) {
    let now = value.now; let calls = 0; let saves = 0; const store = new MemoryStore(fixture()); const save = store.save.bind(store);
    store.save = async bundle => {saves++; await save(parseBundle(bundle));};
    const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: value.accessToken, refreshToken: value.refreshToken, expiresIn: value.expiresIn};}, () => now);
    try {
      await assert.rejects(auth.credentials(), /AUTH_RECOVERY_REQUIRED/); auth.start();
      assert.equal(auth.diagnostics().lastAuthErrorCode, "REFRESH_RESPONSE_INVALID"); assert.equal(auth.diagnostics().nextRetryAt, null);
      now += 1_000_000; t.mock.timers.tick(50_000); await flush();
      await assert.rejects(auth.refresh(), /AUTH_RECOVERY_REQUIRED/); assert.equal(calls, 1); assert.equal(saves, 1); assert.equal(store.value?.refreshPending, true);
    } finally {await auth.close();}
  }
});

test("a corrupt restore is terminal and never retried as a temporary Keychain lock", async t => {
  t.mock.timers.enable({apis: ["setInterval"]});
  let now = 1000; let loads = 0; let calls = 0; const store = new MemoryStore(fixture());
  store.load = async () => {loads++; throw new SessionError("AUTH_STORE_INVALID");};
  const auth = new AuthManager(store, async () => {calls++; throw new Error("must not exchange");}, () => now);
  try {
    await auth.boot; auth.start(); assert.equal(auth.diagnostics().authState, "reauth_required");
    assert.equal(auth.diagnostics().lastAuthErrorCode, "AUTH_STORE_INVALID"); assert.equal(auth.diagnostics().nextRetryAt, null);
    now += 1_000_000; t.mock.timers.tick(50_000); await flush();
    await Promise.all(Array.from({length: 40}, () => assert.rejects(auth.credentials(), /REAUTH_REQUIRED/)));
    await assert.rejects(auth.refresh(), /REAUTH_REQUIRED/); assert.equal(loads, 1); assert.equal(calls, 0);
  } finally {await auth.close();}
});

test("restoring expired credentials refreshes within the recovering call and shares one exchange", async () => {
  let now = 1000; let readable = false; let calls = 0; let changes = 0; const old = fixture(); const store = new MemoryStore(old); const load = store.load.bind(store);
  store.load = async () => {if (!readable) throw new Error("locked"); return load();};
  const auth = new AuthManager(store, async previous => {calls++; assert.equal(previous.refreshToken, old.refreshToken); return {kind: "ok", accessToken: "current-a", refreshToken: "current-r", expiresIn: 120};}, () => now);
  auth.on("changed", () => changes++);
  try {
    await auth.boot; readable = true; now = 80_000;
    const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.ok(results.every(value => value.accessToken === "current-a" && value.generation === 1));
    assert.equal(calls, 1); assert.equal(changes, 1); assert.equal(store.value?.refreshPending, false);
  } finally {await auth.close();}
});

test("an expired retained replacement saves exactly before one due refresh in the recovering call", async () => {
  let now = 40_000; let fail = true; let calls = 0; let changes = 0; const store = new MemoryStore(fixture()); const save = store.save.bind(store); const attempted: object[] = [];
  store.save = async value => {if (value.generation === 1 && !value.refreshPending) {attempted.push(structuredClone(value)); if (fail) throw new Error("locked");} await save(value);};
  const auth = new AuthManager(store, async previous => {
    calls++; if (calls === 1) return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 1};
    assert.equal(previous.refreshToken, "retained-r"); assert.equal(previous.generation, 1); assert.equal(store.value?.refreshPending, true);
    return {kind: "ok", accessToken: "current-a", refreshToken: "current-r", expiresIn: 120};
  }, () => now);
  auth.on("changed", () => changes++);
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); assert.equal(changes, 0);
    fail = false; now = auth.diagnostics().nextRetryAt!;
    const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.ok(results.every(value => value.accessToken === "current-a" && value.generation === 2));
    assert.deepEqual(attempted[0], attempted[1]); assert.equal(calls, 2); assert.equal(changes, 1); assert.equal(store.value?.refreshToken, "current-r");
  } finally {await auth.close();}
});

test("recovery makes at most one additional due exchange and preserves temporary backoff", async () => {
  let now = 1000; let readable = false; let calls = 0; const store = new MemoryStore(fixture()); const load = store.load.bind(store);
  store.load = async () => {if (!readable) throw new Error("locked"); return load();};
  const auth = new AuthManager(store, async () => {calls++; return {kind: "temporary", code: "ENETDOWN"};}, () => now);
  try {
    await auth.boot; readable = true; now = 80_000;
    await assert.rejects(auth.credentials(), /AUTH_RETRY_WAIT/); assert.equal(calls, 1);
    await assert.rejects(auth.credentials(), /AUTH_RETRY_WAIT/); assert.equal(calls, 1); assert.ok(auth.diagnostics().nextRetryAt! > now);
    assert.ok(auth.diagnostics().authRecoveryHistory.some(event => event.code === "ENETDOWN"));
    assert.equal(auth.diagnostics().authRecoveryHistory.some(event => event.phase === "exchange" && event.outcome === "succeeded"), false);
  } finally {await auth.close();}
});

test("two unresolved enrollments restore their prior attempt instead of overwriting the first durable device", async () => {
  let now = 40_000; let readable = true; let calls = 0; let oldSaves = 0;
  const old = fixture(); const first = {...fixture(now), expiresAt: null, refreshAt: null}; const second = {...fixture(now), expiresAt: null, refreshAt: null};
  const store = new MemoryStore(old); const save = store.save.bind(store); const load = store.load.bind(store); const changes: string[] = [];
  store.load = async () => {if (!readable) throw new Error("readback locked"); return load();};
  store.save = async value => {
    if (value.udid === old.udid && value.generation === 1) {oldSaves++; throw new Error("old replacement locked");}
    if (value.udid === first.udid) {await save(value); readable = false; throw new Error("A written then error");}
    if (value.udid === second.udid) throw new Error("B failed before write");
    await save(value);
  };
  const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now);
  auth.on("changed", event => {if (event.enrollment) changes.push(event.epoch);});
  try {
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);
    await assert.rejects(auth.install(first), /A written then error/); await assert.rejects(auth.install(second), /B failed before write/);
    readable = true; now = auth.diagnostics().nextRetryAt!;
    await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/); // B absent: reinstate A's unresolved attempt.
    const results = await Promise.all(Array.from({length: 40}, () => auth.credentials()));
    assert.ok(results.every(value => value.udid === first.udid)); assert.equal(store.value?.udid, first.udid);
    assert.equal(store.value?.refreshToken, first.refreshToken); assert.equal(oldSaves, 1); assert.equal(calls, 1);
    assert.deepEqual(changes, [`${first.accountId}:${first.udid}`]);
  } finally {await auth.close();}
});
