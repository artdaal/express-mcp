import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import nacl from "tweetnacl";
import { b64, decryptMessage, encryptMessage, qrHeaders, signingKey, verifyQrHeaders, WireMessage } from "../src/session/crypto.js";
import { fixture } from "./session-fixtures.js";
import { QrEnrollment } from "../src/session/qr.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG } from "../src/session/types.js";

test("QR signature verifier rejects body, target, nonce and public-key substitution", () => {
  const signer = signingKey(); const url = "https://ets.chat.example.com/api/v1/authentication/register_confirm/qr";
  const body = JSON.stringify({registration_id: signer.id, temp_token: "synthetic-token"});
  const headers = qrHeaders(url, body, signer);
  assert.equal(verifyQrHeaders(url, body, headers, signer), true);
  assert.equal(verifyQrHeaders(url, body + " ", headers, signer), false);
  assert.equal(verifyQrHeaders(url + "/other", body, headers, signer), false);
  assert.equal(verifyQrHeaders(url, body, {...headers, "Express-Request-Nonce": b64(randomBytes(32))}, signer), false);
  assert.equal(verifyQrHeaders(url, body, headers, {...signer, public: signingKey().public}), false);
});

test("E2E verifies exact sender, signature, account key and chat/sync AAD", async () => {
  const bundle = fixture(); const chat = randomUUID();
  const keys = [{id: bundle.ctsKey.id, kind: "cts", user_huid: bundle.accountId, body: bundle.ctsKey.public}, {id: bundle.signing.id, kind: "ed25519", user_huid: bundle.accountId, body: bundle.signing.public}];
  const payload = await encryptMessage(chat, "Точное сообщение 🔒\n  без нормализации", bundle, [keys[0]!]);
  const event: WireMessage = {...payload, key: payload.keys[0]!, sender: bundle.accountId, sender_key_id: bundle.ctsKey.id, event_type: "message_new"};
  assert.equal(await decryptMessage(event, bundle.ctsKey, keys), "Точное сообщение 🔒\n  без нормализации");
  await assert.rejects(decryptMessage({...event, group_chat_id: randomUUID()}, bundle.ctsKey, keys), /CRYPTO_DECRYPT_FAILED/);
  await assert.rejects(decryptMessage({...event, sender: randomUUID()}, bundle.ctsKey, keys), /CRYPTO_KEY_MISSING/);
  await assert.rejects(decryptMessage({...event, payload: event.payload.slice(0, -4) + "AAAA"}, bundle.ctsKey, keys), /CRYPTO_SIGNATURE_INVALID/);
  await assert.rejects(decryptMessage({...event, key: {...event.key, key_id: randomUUID()}}, bundle.ctsKey, keys), /CRYPTO_KEY_MISMATCH/);
});

test("QR normal enrollment keeps existing CTS/RTS keys and registers only signing keys", async () => {
  const source = fixture(Date.now()); const requests: {origin: string; route: string; method: string; body: any}[] = [];
  let qr: any;
  const fetcher: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init?.headers); assert.equal(headers.has("origin"), false); assert.equal(headers.has("referer"), false);
    requests.push({origin: new URL(String(url)).origin, route, method: init?.method ?? "GET", body}); let result: unknown = null;
    if (route.endsWith("mobile_to_web/request")) {
      assert.equal(body.platform, "desktop"); assert.equal(body.device, "Express MCP");
      assert.equal(typeof body.device_hostname, "string"); assert.ok(body.device_hostname.length);
      assert.match(body.device_software, /\d/);
      const nonce = randomBytes(24); const clear = Buffer.from(JSON.stringify({cts_host: "chat.example.com", rts_host: "ets.chat.example.com", cts_pub_key_id: source.ctsKey.id, cts_priv_key_body: source.ctsKey.secret, rts_pub_key_id: source.rtsKey.id, rts_priv_key_body: source.rtsKey.secret}));
      result = {registration_data: b64(Buffer.concat([nonce, nacl.secretbox(clear, nonce, Buffer.from(qr.registration_key, "base64"))])), cts_registration_token: "temporary-cts", rts_registration_token: "temporary-rts"};
    } else if (route === "/api/v1/authentication/register_confirm/qr") result = {user_huid: source.accountId, auth_token: source.etsToken};
    else if (route === "/api/v1/ad_integration/register_confirm/qr") result = {access_token: source.accessToken, refresh_token: source.refreshToken, expires_in: 60};
    else if (route === "/api/v1/kdc/keys/") result = [{id: source.ctsKey.id, body: source.ctsKey.public, kind: "cts", user_huid: source.accountId}];
    else if (route.endsWith("/kdc/start")) result = source.serverPublicKey;
    else if (route.endsWith("/authentication/activation")) {
      assert.equal(route, "/api/v1/apigw/api/v1/authentication/activation");
      const signing = requests.find(r => r.route.startsWith("/api/v2/kdc/keys/"))!.body;
      const sig = /keyId="([^"]+)",algorithm="ed25519",headers="([^"]+)",signature="([^"]+)",created=(\d+)/.exec(headers.get("signature")!)!;
      assert.equal(sig[1], signing.id);
      assert.equal(sig[2], "(request-target) (created) (rts-access-token) express-request-nonce digest");
      const publicKey = createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signing.key, "base64")]), format: "der", type: "spki"});
      const canonical = (target: string) => Buffer.from(`(request-target): put ${target}\n(created): ${sig[4]}\n(rts-access-token): ${source.etsToken}\nexpress-request-nonce: ${headers.get("express-request-nonce")}\ndigest: ${headers.get("digest")}`);
      assert.equal(verify(null, canonical("/api/v1/authentication/activation"), publicKey, Buffer.from(sig[3]!, "base64")), true);
      assert.equal(verify(null, canonical(route), publicKey, Buffer.from(sig[3]!, "base64")), false);
    }
    return new Response(JSON.stringify({status: "ok", result}));
  };
  const http = new SessionHttp(DEFAULT_CONFIG, fetcher);
  const enrollment = new QrEnrollment(http); qr = JSON.parse(enrollment.payload());
  const result = await enrollment.run();
  assert.deepEqual(result.ctsKey, source.ctsKey); assert.deepEqual(result.rtsKey, source.rtsKey);
  const registrations = requests.filter(r => r.route.startsWith("/api/v2/kdc/keys/")); assert.equal(registrations.length, 1); assert.equal(registrations[0]!.origin, source.ctsOrigin); assert.equal(registrations[0]!.body.kind, "ed25519"); assert.equal(registrations[0]!.body.algo, "xsalsa20");
  const confirmIndex = requests.findIndex(r => r.route === "/api/v1/authentication/register_confirm/qr");
  assert.deepEqual(requests.slice(0, confirmIndex).filter(r => r.route === "/api/v1/kdc/start").map(r => r.origin), [DEFAULT_CONFIG.etsOrigin, source.ctsOrigin]);
  const activation = requests.find(r => r.route.endsWith("/authentication/activation")); assert.equal(activation?.origin, source.ctsOrigin);
  assert.equal(requests.some(r => r.body?.kind === "cts"), false); assert.equal(result.refreshAt! - result.issuedAt, 30_000);
  const diagnostics = http.diagnostics();
  assert.deepEqual(diagnostics.lastQrRequests.map(step => step.phase), ["qr_wait", "ets_confirm", "cts_confirm"]);
  assert.ok(diagnostics.lastQrRequests.every(step => step.signatureVerified && step.registrationIdMatches));
  assert.equal(diagnostics.lastQrRequests[2]!.tempTokenBytes, Buffer.byteLength("temporary-cts"));
  assert.equal(diagnostics.lastQrRequests[2]!.tokenMatchesQrResponse, true);
  const safe = JSON.stringify(diagnostics);
  for (const secret of [qr.registration_id, qr.registration_token, qr.registration_key, "temporary-cts", "temporary-rts", requests[0]!.body.device_hostname, source.accessToken, source.refreshToken]) assert.ok(!safe.includes(secret));
  http.beginEnrollment(); assert.deepEqual(http.diagnostics(), {clientProfile: "native", clientAppVersion: "3.71.16", lastUpstreamError: null, lastQrRequests: []});
});
test("QR with missing shared keys fails before confirm or KDC mutation", async () => {
  let qr: any; let calls = 0;
  const enrollment = new QrEnrollment(new SessionHttp(DEFAULT_CONFIG, async () => {
    calls++; const nonce = randomBytes(24); return new Response(JSON.stringify({result: {registration_data: b64(Buffer.concat([nonce, nacl.secretbox(Buffer.from("{}"), nonce, Buffer.from(qr.registration_key, "base64"))]))}}));
  }));
  qr = JSON.parse(enrollment.payload()); await assert.rejects(enrollment.run()); assert.equal(calls, 1);
});

test("QR rejects mismatched response registration and malformed tokens before confirmation", async () => {
  for (const bad of [{registration_id: randomUUID()}, {cts_registration_token: {secret: "never-serialize"}, rts_registration_token: "test"}]) {
    let calls = 0;
    const enrollment = new QrEnrollment(new SessionHttp(DEFAULT_CONFIG, async () => { calls++; return new Response(JSON.stringify({result: bad})); }));
    await assert.rejects(enrollment.run(), /QR_REGISTRATION_MISMATCH|QR_KEYS_MISSING/);
    assert.equal(calls, 1);
  }
});

test("CTS nested generic error is classified without exposing server details", async () => {
  for (const detail of ["Internal Server Error", "secret-server-detail"]) {
    const http = new SessionHttp(DEFAULT_CONFIG, async () => new Response(JSON.stringify({errors: {detail}}), {status: 500}));
    await assert.rejects(http.json(DEFAULT_CONFIG.ctsOrigin, "/api/v1/ad_integration/register_confirm/qr"), /UPSTREAM_HTTP_500/);
    assert.equal(http.diagnostics().lastUpstreamError?.serverReason, detail === "Internal Server Error" ? "INTERNAL_SERVER_ERROR" : "UNCLASSIFIED_SERVER_ERROR");
    assert.ok(!JSON.stringify(http.diagnostics()).includes(detail));
  }
});
