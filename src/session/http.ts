import { RefreshResult } from "./auth.js";
import { AuthBundle, replacementBundle, SessionConfig, SessionError } from "./types.js";

export type Fetcher = typeof fetch;
// Only transport evidence that proves no HTTP transmission permits token reuse.
// General timeouts, resets and arbitrary error text never establish that fact.
function noTransmissionCode(error: unknown, seen = new Set<unknown>()): string | null {
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  const value = error as {name?: unknown; code?: unknown; syscall?: unknown; cause?: unknown};
  if (value.name === "AbortError" || value.name === "TimeoutError") return null;
  const dns = value.code === "ENOTFOUND" || value.code === "EAI_AGAIN";
  const connectOnly = ["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN"].includes(value.code as string);
  const known = dns || connectOnly || value.code === "ECONNREFUSED" || value.code === "UND_ERR_CONNECT_TIMEOUT";
  if (value.code !== undefined && !known) return null;
  if (value.syscall !== undefined && value.syscall !== "connect" && !(dns && ["getaddrinfo", "getnameinfo", "queryA", "queryAAAA"].includes(value.syscall as string))) return null;
  if (value.cause !== undefined && !noTransmissionCode(value.cause, new Set(seen))) return null;
  if (error instanceof AggregateError) {
    // NodeAggregateError copies the first leaf's code, but omits its syscall.
    // That summary is supported metadata; certainty still comes from every leaf.
    if (!error.errors.length) return null;
    if (connectOnly && value.syscall !== "connect" && error.errors[0]?.code !== value.code) return null;
    const codes = error.errors.map(leaf => noTransmissionCode(leaf, new Set(seen)));
    return codes.every(code => code !== null) ? codes.every(code => code === codes[0]) ? codes[0]! : "REFRESH_CONNECT_FAILED" : null;
  }
  if (known) return connectOnly && value.syscall !== "connect" ? null : value.code === "ETIMEDOUT" ? "REFRESH_CONNECT_TIMEOUT" : value.code as string;
  return noTransmissionCode(value.cause, seen);
}
class NoTransmissionError extends SessionError {
  constructor(code: string, readonly transportCode: string) { super(code); }
}
export async function readJson(response: Response, limit = 4 * 1024 * 1024): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new SessionError("UNSUPPORTED_PROTOCOL");
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > limit) { await reader.cancel(); throw new SessionError("UPSTREAM_RESPONSE_TOO_LARGE"); }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new SessionError("UNSUPPORTED_PROTOCOL"); }
}
export function resultOf(body: any): any { return body?.result ?? body; }
function clientHeaders(config: SessionConfig): Record<string, string> {
  if (config.clientProfile === "express-cli-web") return {
    Accept: "application/json, text/plain, */*", "Accept-Language": "ru-RU,ru;q=0.9", Connection: "keep-alive",
    Origin: config.webOrigin, Referer: `${config.webOrigin}/`, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"macOS"',
  };
  return { Accept: "application/json, text/plain, */*", "User-Agent": "ExpressMCP/0.1 (macOS; desktop; protocol 3.71.16)" };
}
export interface QrRequestProof {
  phase: "qr_wait" | "ets_confirm" | "cts_confirm";
  at: number; bodyBytes: number; tempTokenBytes: number | null;
  registrationIdMatches: boolean; signatureVerified: boolean;
  tokenMatchesQrResponse: boolean | null;
}
export class SessionHttp {
  private pinnedCtsOrigin: string | null = null;
  private lastError: {host: string; phase: string; httpStatus: number | null; code: string; at: number; serverReason?: string} | null = null;
  private qrRequests: QrRequestProof[] = [];
  constructor(readonly config: SessionConfig, private readonly fetcher: Fetcher = fetch) {}
  diagnostics() { return {clientProfile: this.config.clientProfile, clientAppVersion: this.config.appVersion, lastUpstreamError: this.lastError, lastQrRequests: this.qrRequests.map(step => ({...step}))}; }
  beginEnrollment() { this.lastError = null; this.qrRequests = []; }
  recordQrRequest(proof: QrRequestProof) { this.qrRequests = [...this.qrRequests, {...proof}].slice(-3); }
  authorizeCtsOrigin(value: string): string {
    let origin: URL;
    try { origin = new URL(value.includes("://") ? value : `https://${value}`); } catch { throw new SessionError("QR_CTS_ORIGIN_DENIED"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.port) throw new SessionError("QR_CTS_ORIGIN_DENIED");
    const exact = origin.origin === this.config.ctsOrigin;
    // Pairing may only select the explicitly configured CTS origin.
    if (!exact) throw new SessionError("QR_CTS_ORIGIN_DENIED");
    this.pinnedCtsOrigin = origin.origin; return origin.origin;
  }
  async response(origin: string, route: string, options: RequestInit = {}, timeout = 20_000) {
    if (![this.config.ctsOrigin, this.config.etsOrigin, this.pinnedCtsOrigin].includes(origin) || !route.startsWith("/api/") || route.startsWith("//") || new URL(route, origin).origin !== origin) throw new SessionError("UPSTREAM_ORIGIN_DENIED");
    return this.fetchResponse(origin, route, options, timeout);
  }
  async fileResponse(origin: string, route: string, token: string) {
    if (origin !== this.pinnedCtsOrigin || !/^\/uploads\/files\/[0-9a-f-]{36}\/[0-9a-f]{32}\.(?:bin|png|jpg)(?:\?[^#\\\s]*)?$/.test(route)) throw new SessionError("UPSTREAM_ORIGIN_DENIED");
    return this.fetchResponse(origin, route, {method: "GET", headers: {Authorization: `Bearer ${token}`}}, 20_000);
  }
  private async fetchResponse(origin: string, route: string, options: RequestInit, timeout: number) {
    try {
      // A native desktop client has no web page origin. The official macOS
      // client's successful auth requests carry neither Origin nor Referer.
      const response = await this.fetcher(new URL(route, origin), { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(timeout), headers: { ...clientHeaders(this.config), ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...options.headers } });
      if (!response.ok) this.recordError(origin, route, `HTTP_${response.status}`, response.status);
      return response;
    } catch (error: any) {
      const noSend = noTransmissionCode(error);
      const code = ["AbortError", "TimeoutError"].includes(error?.name) ? "UPSTREAM_TIMEOUT" : error?.cause?.code === "ENOTFOUND" ? "UPSTREAM_DNS_ERROR" : ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error?.cause?.code) ? "UPSTREAM_TLS_ERROR" : "UPSTREAM_UNAVAILABLE";
      this.recordError(origin, route, code, null);
      throw noSend ? new NoTransmissionError(code, noSend) : new SessionError(code);
    }
  }
  private recordError(origin: string, route: string, code: string, httpStatus: number | null) {
    const phase = route.includes("mobile_to_web/request") ? "qr_wait" : route.includes("register_confirm") ? (origin === this.config.etsOrigin ? "ets_confirm" : "cts_confirm") : route.includes("token/refresh") ? "refresh" : route.includes("/kdc/") ? "kdc" : route.includes("activation") ? "activation" : "api";
    this.lastError = {host: new URL(origin).hostname, phase, httpStatus, code, at: Date.now()};
  }
  async json(origin: string, route: string, options: RequestInit = {}, timeout?: number) {
    const response = await this.response(origin, route, options, timeout);
    if (!response.ok) {
      const known = ["activation_not_found", "activation_register_keys_not_found", "confirmation_code_invalid", "cts_only_registration_not_allowed", "cts_only_registration_outside_contour", "cts_server_not_found", "decryption_error", "denied", "encrypt_rts_token_error", "encrypt_rts_token_input_error", "error", "error_on_register_request", "huid_not_found", "internal_error", "not_found", "permission_denied", "registration_confirm_attempts_exceeded", "routing_error", "rts_host_not_found", "server_error", "server_not_found", "unexpected_error", "validation_error", "keycloak_error", "openid_error", "unauthorized", "internal_server_error", "request_invalid_signature", "invalid_signature", "invalid_token", "token_expired", "registration_timeout", "registration_not_found", "rts_registration_not_found", "cts_registration_not_found", "cts_registration_not_supported", "registration_request_already_exist", "openid_session_not_found", "openid_offline_session_invalid", "keycloak_refresh_error", "refresh_token_error", "refresh_token_not_found", "invalid_registration_token", "invalid_registration_id", "temp_token_not_found", "temp_token_expired", "activation_limit_exceeded", "not_allowed", "invalid_request", "invalid_data"];
      try { const failure = await readJson(response, 64 * 1024); const reason = failure?.reason ?? failure?.result?.reason; if (this.lastError) this.lastError.serverReason = known.includes(reason) ? reason : failure?.errors?.detail === "Internal Server Error" ? "INTERNAL_SERVER_ERROR" : "UNCLASSIFIED_SERVER_ERROR"; } catch {}
      throw new SessionError(response.status === 401 || response.status === 403 ? "UPSTREAM_UNAUTHORIZED" : `UPSTREAM_HTTP_${response.status}`);
    }
    if (response.status === 204) return null;
    const body = await readJson(response);
    if (body?.status === "error") throw new SessionError("UPSTREAM_REJECTED");
    return resultOf(body);
  }
  async fileFailure(response: Response) {
    // Technical error codes only; never serialize arbitrary upstream error bodies.
    const known = ["malformed_request", "bad_request", "validation_error", "invalid_params", "invalid_mime_type", "invalid_file_name", "invalid_upload_shapes", "invalid_metadata", "invalid_content", "invalid_content_shapes", "invalid_request", "unsupported_mime_type", "denied", "permission_denied", "foreign_contour", "dlp", "malware", "rules_restriction", "token_expired", "invalid_token", "not_found", "invalid_upload_range", "invalid_subject", "invalid_chunk_size", "max_file_size_exceeded"];
    try {
      const body = await readJson(response, 64 * 1024);
      const reason = body?.reason ?? body?.result?.reason;
      if (this.lastError) this.lastError.serverReason = known.includes(reason) ? reason : "UNCLASSIFIED_FILE_ERROR";
    } catch {if(this.lastError) this.lastError.serverReason = "NON_JSON_FILE_ERROR";}
    return new SessionError(`UPSTREAM_HTTP_${response.status}`);
  }
  async refresh(bundle: AuthBundle): Promise<RefreshResult> {
    const ctsOrigin = this.authorizeCtsOrigin(bundle.ctsOrigin);
    let response: Response;
    try { response = await this.response(ctsOrigin, "/api/v1/ad_integration/token/refresh", { method: "POST", headers: { Authorization: `Bearer ${bundle.accessToken}` }, body: JSON.stringify({ refresh_token: bundle.refreshToken }) }); }
    catch (error) { return error instanceof NoTransmissionError ? { kind: "temporary", code: error.transportCode } : { kind: "ambiguous", code: "REFRESH_RESPONSE_LOST" }; }
    let body: any;
    try { body = await readJson(response, 256 * 1024); }
    catch { return { kind: "ambiguous", code: "REFRESH_RESPONSE_INVALID" }; }
    const reason = body?.reason ?? body?.result?.reason;
    if (["openid_session_not_found", "refresh_token_error", "refresh_token_not_found", "openid_offline_session_invalid"].includes(reason)) return { kind: "permanent", code: reason.toUpperCase() };
    if (reason === "keycloak_refresh_error" || response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return { kind: "temporary", code: reason === "keycloak_refresh_error" ? "KEYCLOAK_REFRESH_ERROR" : "RATE_LIMITED", retryAfterMs: Number.isFinite(seconds) ? Math.min(300_000, Math.max(0, seconds * 1000)) : 10_000 };
    }
    const value = resultOf(body);
    if (response.ok && body?.status !== "error" && typeof value?.cts_access_token === "string" && value.cts_access_token && typeof value.refresh_token === "string" && value.refresh_token) {
      const ttl = value.expires_in;
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0)) return { kind: "ambiguous", code: "REFRESH_RESPONSE_INVALID" };
      if (!replacementBundle(bundle, value.cts_access_token, value.refresh_token, ttl ?? null, Date.now())) return { kind: "ambiguous", code: "REFRESH_RESPONSE_INVALID" };
      return { kind: "ok", accessToken: value.cts_access_token, refreshToken: value.refresh_token, expiresIn: ttl ?? null };
    }
    return { kind: "ambiguous", code: "REFRESH_OUTCOME_UNKNOWN" };
  }
}
