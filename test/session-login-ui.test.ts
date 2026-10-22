import test from "node:test";
import assert from "node:assert/strict";
import { LoginUi } from "../src/session/login-ui.js";
import { AuthManager } from "../src/session/auth.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG, SessionError } from "../src/session/types.js";
import { fixture, MemoryStore } from "./session-fixtures.js";
import { QrEnrollment } from "../src/session/qr.js";

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate());
};

test("local QR renewal accepts same-origin null Origin with CSRF, rejects cross-origin and missing token", async () => {
  let calls = 0;
  const http = new SessionHttp(DEFAULT_CONFIG, async () => {calls++; return new Response(JSON.stringify({status: "error", reason: "internal_server_error"}), {status: 500});});
  const auth = new AuthManager(new MemoryStore(null), async () => {throw new Error("must not refresh");});
  const ui = new LoginUi(auth, http);
  const waitForFailure = async () => {
    const deadline = Date.now() + 2000;
    while (ui.diagnostics().enrollmentState !== "failed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(ui.diagnostics().enrollmentState, "failed");
  };
  try {
    const {url} = await ui.start();
    await waitForFailure();
    const page = await fetch(url); const html = await page.text();
    assert.equal(page.headers.get("cache-control"), "no-store"); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(html, /UPSTREAM_HTTP_500/);
    assert.equal(html.includes("registration_token"), false); assert.equal(html.includes("data:image"), false);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]; assert.ok(csrf);
    const denied = await fetch(url + "/renew", {method: "POST", headers: {Origin: "https://unrelated.example", "Sec-Fetch-Site": "cross-site"}, body: new URLSearchParams({csrf})}); assert.equal(denied.status, 403);
    const noToken = await fetch(url + "/renew", {method: "POST", headers: {Origin: new URL(url).origin}}); assert.equal(noToken.status, 403);
    const renewed = await fetch(url + "/renew", {method: "POST", headers: {Origin: "null", "Sec-Fetch-Site": "same-origin"}, body: new URLSearchParams({csrf}), redirect: "manual"});
    await waitForFailure();
    assert.equal(renewed.status, 303); assert.equal(renewed.headers.get("location"), new URL(url).pathname); assert.equal(calls, 2);
    assert.equal(http.diagnostics().lastUpstreamError?.serverReason, "internal_server_error");
  } finally {await ui.stop(); await auth.close();}
});

test("CTS origin from QR is pinned to deployment and cannot redirect secrets elsewhere", () => {
  const http = new SessionHttp({...DEFAULT_CONFIG, ctsOrigin: "https://cts1.chat.example.com"});
  assert.equal(http.authorizeCtsOrigin("https://cts1.chat.example.com/"), "https://cts1.chat.example.com");
  for (const origin of ["https://chat.example.com.attacker.example", "http://cts1.chat.example.com", "https://cts1.chat.example.com@evil.example", "https://cts1.chat.example.com:444", "https://cts1.chat.example.com/path"]) assert.throws(() => http.authorizeCtsOrigin(origin), /QR_CTS_ORIGIN_DENIED/);
  const exact = new SessionHttp({...DEFAULT_CONFIG, ctsOrigin: "https://cts1.chat.example.com"});
  assert.throws(() => exact.authorizeCtsOrigin("cts2.chat.example.com"), /QR_CTS_ORIGIN_DENIED/);
});

test("a login page keeps refreshing pending persistence and completes on its exact delayed enrollment adoption", async t => {
  let now = 1000; let readable = true; let issued = fixture(); const store = new MemoryStore(null); const save = store.save.bind(store); const load = store.load.bind(store);
  t.mock.method(QrEnrollment.prototype, "run", async function(this: QrEnrollment) {
    issued = {...fixture(), udid: this.udid, expiresAt: null, refreshAt: null}; return issued;
  });
  store.save = async value => {await save(value); readable = false; throw new SessionError("KEYCHAIN_UNAVAILABLE");};
  store.load = async () => {if (!readable) throw new SessionError("KEYCHAIN_UNAVAILABLE"); return load();};
  const auth = new AuthManager(store, async () => {throw new Error("must not refresh");}, () => now);
  const ui = new LoginUi(auth, new SessionHttp(DEFAULT_CONFIG));
  try {
    await auth.boot; const {url} = await ui.start(); await waitFor(() => ui.diagnostics().enrollmentState === "failed");
    const pending = await (await fetch(url)).text();
    assert.match(pending, /http-equiv="refresh"/); assert.match(pending, /обновится автоматически/);
    assert.equal(pending.includes("Новый QR"), false); assert.equal(pending.includes("<form"), false); assert.equal(pending.includes("data:image"), false);
    auth.emit("changed", {epoch: `${fixture().accountId}:${issued.udid}`, enrollment: true});
    assert.equal(ui.diagnostics().enrollmentState, "failed");
    auth.emit("changed", {epoch: `${issued.accountId}:${issued.udid}`, enrollment: false});
    assert.equal(ui.diagnostics().enrollmentState, "failed");
    readable = true; now = auth.diagnostics().nextRetryAt!; assert.equal((await auth.credentials()).udid, issued.udid);
    assert.equal(ui.diagnostics().enrollmentState, "complete"); assert.equal(ui.diagnostics().enrollmentErrorCode, null);
    const complete = await (await fetch(url)).text(); assert.match(complete, /Устройство подключено/);
    assert.equal(complete.includes("Новый QR"), false); assert.equal(complete.includes('http-equiv="refresh"'), false);
    for (const secret of [issued.accessToken, issued.refreshToken, issued.udid, issued.accountId]) assert.equal(complete.includes(secret), false);
  } finally {await ui.stop(); assert.equal(auth.listenerCount("changed"), 0); await auth.close();}
});

test("obsolete login cycles and stopped pages ignore delayed adoption of an earlier enrollment", async t => {
  for (const stop of [false, true]) {
    let now = 1000; let readable = true; let cycles = 0; let first = fixture(); const store = new MemoryStore(null); const save = store.save.bind(store); const load = store.load.bind(store);
    const mocked = t.mock.method(QrEnrollment.prototype, "run", async function(this: QrEnrollment) {
      if (++cycles > 1) throw new SessionError("QR_KEYS_MISSING");
      first = {...fixture(), udid: this.udid, expiresAt: null, refreshAt: null}; return first;
    });
    store.save = async value => {await save(value); readable = false; throw new SessionError("KEYCHAIN_UNAVAILABLE");};
    store.load = async () => {if (!readable) throw new SessionError("KEYCHAIN_UNAVAILABLE"); return load();};
    const auth = new AuthManager(store, async () => {throw new Error("must not refresh");}, () => now);
    const ui = new LoginUi(auth, new SessionHttp(DEFAULT_CONFIG));
    try {
      await auth.boot; const {url} = await ui.start(); await waitFor(() => ui.diagnostics().enrollmentState === "failed");
      if (stop) await ui.stop();
      else {
        // An explicit new start supersedes the old page and its pending attempt.
        const newer = await ui.start(); await waitFor(() => cycles === 2 && ui.diagnostics().enrollmentState === "failed");
        assert.match(await (await fetch(newer.url)).text(), /QR_KEYS_MISSING/);
      }
      readable = true; now = auth.diagnostics().nextRetryAt!; assert.equal((await auth.credentials()).udid, first.udid);
      assert.equal(ui.diagnostics().enrollmentState, "failed");
      if (stop) assert.equal(auth.listenerCount("changed"), 0);
    } finally {mocked.mock.restore(); await ui.stop(); await auth.close();}
  }
});

test("a pending login page stops waiting when reconciliation proves its enrollment was not saved", async t => {
  for (const priorReplacement of [false, true]) {
    let now = 40_000; let readable = true; let calls = 0; const old = fixture(); const store = new MemoryStore(priorReplacement ? old : null); const load = store.load.bind(store); const save = store.save.bind(store);
    const mocked = t.mock.method(QrEnrollment.prototype, "run", async function(this: QrEnrollment) {return {...fixture(), udid: this.udid, expiresAt: null, refreshAt: null};});
    store.save = async value => {
      if (value.udid === old.udid && value.refreshPending) {await save(value); return;}
      if (value.udid !== old.udid) readable = false;
      throw new SessionError("KEYCHAIN_UNAVAILABLE");
    };
    store.load = async () => {if (!readable) throw new SessionError("KEYCHAIN_UNAVAILABLE"); return load();};
    const auth = new AuthManager(store, async () => {calls++; return {kind: "ok", accessToken: "retained-a", refreshToken: "retained-r", expiresIn: 120};}, () => now); const ui = new LoginUi(auth, new SessionHttp(DEFAULT_CONFIG));
    try {
      await auth.boot; if (priorReplacement) await assert.rejects(auth.credentials(), /KEYCHAIN_LOCKED/);
      const {url} = await ui.start(); await waitFor(() => ui.diagnostics().enrollmentState === "failed");
      assert.match(await (await fetch(url)).text(), /http-equiv="refresh"/);
      readable = true; now = auth.diagnostics().nextRetryAt!; await assert.rejects(auth.credentials(), priorReplacement ? /KEYCHAIN_LOCKED/ : /REAUTH_REQUIRED/);
      if (priorReplacement) {assert.equal(auth.diagnostics().authState, "locked"); assert.equal(auth.diagnostics().lastAuthErrorCode, "REFRESH_SAVE_FAILED");}
      const failed = await (await fetch(url)).text(); assert.match(failed, /Новый QR/); assert.equal(failed.includes('http-equiv="refresh"'), false);
      assert.equal(ui.diagnostics().enrollmentState, "failed"); assert.equal(calls, priorReplacement ? 1 : 0);
    } finally {mocked.mock.restore(); await ui.stop(); await auth.close();}
  }
});

test("a page GET during an in-flight reconciliation keeps refreshing until its exact enrollment is adopted", async t => {
  let now = 1000; let readable = true; let gated = false; let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}); const finish = new Promise<void>(resolve => {release = resolve;});
  const store = new MemoryStore(null); const save = store.save.bind(store); const load = store.load.bind(store);
  t.mock.method(QrEnrollment.prototype, "run", async function(this: QrEnrollment) {return {...fixture(), udid: this.udid, expiresAt: null, refreshAt: null};});
  store.save = async value => {await save(value); readable = false; throw new SessionError("KEYCHAIN_UNAVAILABLE");};
  store.load = async () => {
    if (!readable) throw new SessionError("KEYCHAIN_UNAVAILABLE");
    if (gated) {entered(); await finish;}
    return load();
  };
  const auth = new AuthManager(store, async () => {throw new Error("must not refresh");}, () => now); const ui = new LoginUi(auth, new SessionHttp(DEFAULT_CONFIG));
  try {
    await auth.boot; const {url} = await ui.start(); await waitFor(() => ui.diagnostics().enrollmentState === "failed");
    readable = true; gated = true; now = auth.diagnostics().nextRetryAt!;
    const recovering = auth.credentials(); await started;
    assert.equal(auth.diagnostics().authRecoveryHistory.at(-1)?.outcome, "started");
    const pending = await (await fetch(url)).text(); assert.match(pending, /http-equiv="refresh"/);
    assert.equal(pending.includes("Новый QR"), false); assert.equal(pending.includes("<form"), false);
    release(); const restored = await recovering; assert.equal(restored.udid, store.value?.udid);
    assert.equal(ui.diagnostics().enrollmentState, "complete"); assert.equal(ui.diagnostics().enrollmentErrorCode, null);
    const complete = await (await fetch(url)).text(); assert.match(complete, /Устройство подключено/);
    assert.equal(complete.includes('http-equiv="refresh"'), false); assert.equal(complete.includes("Новый QR"), false);
  } finally {release(); await ui.stop(); await auth.close();}
});
