import { randomBytes, randomUUID } from "node:crypto";
import { b64, boxSeal, openRegistration, qrHeaders, sharedKey, signingKey, unb64, verifyQrHeaders } from "./crypto.js";
import { desktopMetadata } from "./device.js";
import { QrRequestProof, SessionHttp } from "./http.js";
import { AuthBundle, parseBundle, SessionError } from "./types.js";

// Pair only through the user's mobile approval. Never import or mint a CTS key.
export class QrEnrollment {
  private readonly signer = signingKey();
  private readonly token = b64(randomBytes(64));
  private readonly encryption = randomBytes(32);
  readonly udid = randomUUID();
  readonly expiresAt = Date.now() + 120_000;
  private readonly abort = new AbortController();
  constructor(private readonly http: SessionHttp) {}
  payload(): string { return JSON.stringify({ registration_id: this.signer.id, registration_token: this.token, registration_key: b64(this.encryption), version: 1 }); }
  cancel() { this.abort.abort(); this.encryption.fill(0); }
  async run(): Promise<AuthBundle> {
    const { config } = this.http;
    this.http.beginEnrollment();
    const signed = async (phase: QrRequestProof["phase"], origin: string, route: string, value: {registration_id?: string; rts_registration_id?: string; temp_token?: string; [key: string]: unknown}, timeout = 20_000, expectedToken?: string) => {
      const body = JSON.stringify(value);
      const headers = qrHeaders(`${origin}${route}`, body, this.signer);
      const registrationIdMatches = (value.registration_id ?? value.rts_registration_id) === this.signer.id;
      const signatureVerified = verifyQrHeaders(`${origin}${route}`, body, headers, this.signer);
      const tokenMatchesQrResponse = expectedToken === undefined ? null : value.temp_token === expectedToken;
      this.http.recordQrRequest({phase, at: Date.now(), bodyBytes: Buffer.byteLength(body), tempTokenBytes: value.temp_token === undefined ? null : Buffer.byteLength(value.temp_token), registrationIdMatches, signatureVerified, tokenMatchesQrResponse});
      if (!registrationIdMatches || !signatureVerified || tokenMatchesQrResponse === false) throw new SessionError("QR_REQUEST_INCONSISTENT");
      return this.http.json(origin, route, { method: "POST", body, headers, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]) }, timeout);
    };
    try {
      const metadata = await desktopMetadata(config);
      const pair = await signed("qr_wait", config.etsOrigin, "/api/v1/authentication/qr/mobile_to_web/request", { registration_id: this.signer.id, registration_token: this.token, sign_pub_key: this.signer.public, udid: this.udid, ...metadata }, 120_000);
      if (this.abort.signal.aborted || Date.now() > this.expiresAt) throw new SessionError("QR_EXPIRED");
      if (pair?.registration_id !== undefined && pair.registration_id !== this.signer.id) throw new SessionError("QR_REGISTRATION_MISMATCH");
      if (![pair?.cts_registration_token, pair?.rts_registration_token].every(token => typeof token === "string" && token.length > 0 && token.length <= 64 * 1024)) throw new SessionError("QR_KEYS_MISSING");
      const data = openRegistration(pair?.registration_data, this.encryption);
      if (typeof data?.cts_host !== "string" || typeof data?.rts_host !== "string") throw new SessionError("QR_CTS_ORIGIN_DENIED");
      const ctsOrigin = this.http.authorizeCtsOrigin(data.cts_host);
      const rtsOrigin = new URL(data.rts_host.includes("://") ? data.rts_host : `https://${data.rts_host}`).origin;
      if (rtsOrigin !== config.etsOrigin) throw new SessionError("QR_CTS_ORIGIN_DENIED");
      // No fallback to generating a new account key, even after KDC errors.
      const ctsKey = sharedKey(data?.cts_pub_key_id, data?.cts_priv_key_body);
      const rtsKey = sharedKey(data?.rts_pub_key_id, data?.rts_priv_key_body);
      const fetchServerKeys = async () => {
        const key = await this.http.json(config.etsOrigin, "/api/v1/kdc/start");
        unb64(key, 32); unb64(await this.http.json(ctsOrigin, "/api/v1/kdc/start"), 32);
        return key as string;
      };
      // The reference web flow performs its three registration POSTs first.
      // Native desktop loads public server keys before confirmation.
      let serverPublicKey = config.clientProfile === "express-cli-web" ? null : await fetchServerKeys();
      const ets = await signed("ets_confirm", config.etsOrigin, "/api/v1/authentication/register_confirm/qr", { registration_id: this.signer.id, temp_token: pair.rts_registration_token }, 20_000, pair.rts_registration_token);
      const cts = await signed("cts_confirm", ctsOrigin, "/api/v1/ad_integration/register_confirm/qr", { rts_registration_id: this.signer.id, temp_token: pair.cts_registration_token, ets: true }, 20_000, pair.cts_registration_token);
      if (!ets?.user_huid || !ets?.auth_token || !cts?.access_token || !cts?.refresh_token || (cts.user_huid && cts.user_huid !== ets.user_huid)) throw new SessionError("QR_UNSUPPORTED_RESPONSE");
      serverPublicKey ??= await fetchServerKeys();
      const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
      const current = await this.http.json(ctsOrigin, `/api/v1/kdc/keys/?user_huids=${encodeURIComponent(ets.user_huid)}`, { headers: bearer(cts.access_token) });
      if (!Array.isArray(current) || !current.some(k => k.id === ctsKey.id && k.kind === "cts" && k.user_huid === ets.user_huid && k.body === ctsKey.public)) throw new SessionError("QR_ACCOUNT_KEY_MISMATCH");
      await this.http.json(ctsOrigin, "/api/v1/ad_integration/token", { method: "PUT", headers: bearer(cts.access_token), body: JSON.stringify(metadata) });
      const signing = signingKey();
      // KDC's algo describes its key envelope; signature algorithms remain Ed25519.
      // Native uploadPublicSignKey uses xsalsa20 and registers through CTS.
      const registration = JSON.stringify({ key: signing.public, kind: "ed25519", algo: "xsalsa20", id: signing.id });
      await this.http.json(ctsOrigin, `/api/v2/kdc/keys/${ets.user_huid}`, { method: "POST", headers: bearer(cts.access_token), body: registration });
      const issuedAt = Date.now(); const ttl = cts.expires_in;
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0)) throw new SessionError("QR_UNSUPPORTED_RESPONSE");
      const bundle = parseBundle({ version: 1, generation: 0, accountId: ets.user_huid, udid: this.udid, ctsOrigin, accessToken: cts.access_token, refreshToken: cts.refresh_token, etsToken: ets.auth_token, ctsKey, rtsKey, signing, serverPublicKey, issuedAt, expiresAt: ttl === undefined ? null : issuedAt + ttl * 1000, refreshAt: ttl === undefined ? null : issuedAt + ttl * 500, refreshPending: false, revoked: false });
      // The gateway rewrites the URL; its signature covers the original RTS
      // target, as in the official client's Kmr -> m$e request builder.
      const target = "/api/v1/authentication/activation";
      const route = `/api/v1/apigw${target}`;
      const body = JSON.stringify({ app_version: config.appVersion, locale: "ru", device_meta: metadata.device_meta, device_hostname: metadata.device_hostname });
      await this.http.json(ctsOrigin, route, { method: "PUT", body, headers: { ...qrHeaders(`${ctsOrigin}${target}`, body, signing, "PUT", bundle.etsToken), Authorization: `keyId="${rtsKey.id}",token="${boxSeal(Buffer.from(bundle.etsToken), unb64(serverPublicKey, 32), unb64(rtsKey.secret, 32))}"`, "Express-Proxy-Authorization": `Bearer ${bundle.accessToken}` } });
      if (this.abort.signal.aborted || Date.now() > this.expiresAt) throw new SessionError("QR_EXPIRED");
      return bundle;
    } finally { this.encryption.fill(0); }
  }
}
