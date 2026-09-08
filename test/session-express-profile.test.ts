import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import nacl from "tweetnacl";
import { QrEnrollment } from "../src/session/qr.js";
import { SessionHttp } from "../src/session/http.js";
import { configSchema, DEFAULT_CONFIG } from "../src/session/types.js";
import { fixture } from "./session-fixtures.js";

const reference = JSON.parse(readFileSync(new URL("../../test/fixtures/express-cli-registration.json", import.meta.url), "utf8"));
const config = {...DEFAULT_CONFIG, ctsOrigin: "https://cts1.chat.example.com", clientProfile: "express-cli-web" as const, appVersion: "3.66.47"};

test("express-cli profile matches pinned upstream registration requests and signatures", async () => {
  const source = fixture(); let qr: any; let publicKey = ""; const requests: any[] = [];
  const sensitive = new Set(["registration_id", "rts_registration_id", "registration_token", "sign_pub_key", "temp_token", "udid", "device_hostname"]);
  const http = new SessionHttp(config, async (input, init) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body)); const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, "error");
    if (url.pathname.endsWith("mobile_to_web/request")) publicKey = body.sign_pub_key;
    const signature = /keyId="([^"]+)",algorithm="ed25519",headers="([^"]+)",signature="([^"]+)",created=(\d+)/.exec(headers.get("signature")!)!;
    assert.ok(signature);
    const digest = `SHA-256=${createHash("sha256").update(String(init?.body)).digest("base64")}`;
    const canonical = `(request-target): post ${url.pathname}${url.search}\n(created): ${signature[4]}\nexpress-request-nonce: ${headers.get("express-request-nonce")}\ndigest: ${digest}`;
    const key = createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]), format: "der", type: "spki"});
    const normalizedBody: any = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, sensitive.has(k) ? v === null ? null : {type: typeof v, bytes: Buffer.byteLength(v as string)} : v]));
    if (normalizedBody.device_meta) normalizedBody.device_meta.timezone = "$localTimeZone";
    requests.push({host: url.host, route: url.pathname, method: init?.method, headers: Object.fromEntries([...headers].filter(([k]) => !["signature", "digest", "express-request-nonce"].includes(k))), body: normalizedBody,
      signature: {digestMatches: headers.get("digest") === digest, signatureVerifiedWithNode: verify(null, Buffer.from(canonical), key, Buffer.from(signature[3]!, "base64")), signedFields: signature[2], keyMatchesRegistration: signature[1] === qr.registration_id}});
    if (url.pathname.endsWith("mobile_to_web/request")) {
      const nonce = randomBytes(24); const clear = JSON.stringify({cts_host: "cts1.chat.example.com", rts_host: "ets.chat.example.com", cts_pub_key_id: source.ctsKey.id, cts_priv_key_body: source.ctsKey.secret, rts_pub_key_id: source.rtsKey.id, rts_priv_key_body: source.rtsKey.secret});
      return new Response(JSON.stringify({result: {registration_id: qr.registration_id, registration_data: Buffer.concat([nonce, nacl.secretbox(Buffer.from(clear), nonce, Buffer.from(qr.registration_key, "base64"))]).toString("base64"), cts_registration_token: "c".repeat(224), rts_registration_token: "r".repeat(1754)}}));
    }
    if (url.pathname === "/api/v1/authentication/register_confirm/qr") return new Response(JSON.stringify({result: {user_huid: source.accountId, auth_token: source.etsToken}}));
    assert.equal(url.pathname, "/api/v1/ad_integration/register_confirm/qr");
    return new Response(JSON.stringify({reason: "fixture_stop"}), {status: 418});
  });
  const enrollment = new QrEnrollment(http); qr = JSON.parse(enrollment.payload());
  await assert.rejects(enrollment.run(), /UPSTREAM_HTTP_418/);
  assert.deepEqual(requests, reference.requests);
  assert.equal(http.diagnostics().clientProfile, "express-cli-web");
});

test("compatibility config retains strict profile and origin checks", () => {
  assert.equal(configSchema.parse(DEFAULT_CONFIG).clientProfile, "native");
  assert.equal(configSchema.parse(config).appVersion, "3.66.47");
  assert.equal(configSchema.safeParse({...config, clientProfile: "arbitrary"}).success, false);
  assert.equal(configSchema.safeParse({...config, etsOrigin: "http://ets.chat.example.com"}).success, false);
  const http = new SessionHttp({...config, ctsOrigin: "https://cts1.chat.example.com"});
  assert.throws(() => http.authorizeCtsOrigin("cts2.chat.example.com"), /QR_CTS_ORIGIN_DENIED/);
  assert.throws(() => http.authorizeCtsOrigin("https://cts1.chat.example.com.attacker.example"), /QR_CTS_ORIGIN_DENIED/);
});
