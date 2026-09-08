import test from "node:test";
import assert from "node:assert/strict";
import { LoginUi } from "../src/session/login-ui.js";
import { AuthManager } from "../src/session/auth.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG } from "../src/session/types.js";
import { MemoryStore } from "./session-fixtures.js";

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
