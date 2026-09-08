import { createHash, randomBytes, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import sodium from "libsodium-wrappers-sumo";
import { AccountKey, AuthBundle, SessionError } from "./types.js";

export const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
export function unb64(value: unknown, length?: number): Uint8Array {
  if (typeof value !== "string" || value.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new SessionError("CRYPTO_INVALID_DATA");
  const bytes = Buffer.from(value, "base64");
  if (length !== undefined && bytes.length !== length) throw new SessionError("CRYPTO_INVALID_DATA");
  return bytes;
}
export function signingKey(): AuthBundle["signing"] {
  const seed = randomBytes(32); const pair = nacl.sign.keyPair.fromSeed(seed);
  return { id: randomUUID(), seed: b64(seed), public: b64(pair.publicKey) };
}
export function signature(value: string, signing: AuthBundle["signing"]) {
  return b64(nacl.sign.detached(Buffer.from(value), nacl.sign.keyPair.fromSeed(unb64(signing.seed, 32)).secretKey));
}
export function qrHeaders(url: string, body: string, key: AuthBundle["signing"], method = "POST", token?: string): Record<string, string> {
  const created = Math.floor(Date.now() / 1000); const nonce = b64(randomBytes(32));
  const parsed = new URL(url); const digest = createHash("sha256").update(body).digest("base64");
  const parts = [["(request-target)", `${method.toLowerCase()} ${parsed.pathname}${parsed.search}`], ["(created)", String(created)], ...(token ? [["(rts-access-token)", token]] : []), ["express-request-nonce", nonce], ["digest", `SHA-256=${digest}`]];
  const signed = parts.map(([name, value]) => `${name}: ${value}`).join("\n");
  return { "Content-Type": "application/json", "Express-Request-Nonce": nonce, Digest: `SHA-256=${digest}`, Signature: `keyId="${key.id}",algorithm="ed25519",headers="${parts.map(p => p[0]).join(" ")}",signature="${signature(signed, key)}",created=${created}` };
}
export function verifyQrHeaders(url: string, body: string, headers: Record<string, string>, key: Pick<AuthBundle["signing"], "id" | "public">): boolean {
  try {
    const match = /^keyId="([0-9a-f-]{36})",algorithm="ed25519",headers="\(request-target\) \(created\) express-request-nonce digest",signature="([A-Za-z0-9+/=]+)",created=(\d+)$/.exec(headers.Signature ?? "");
    if (!match || match[1] !== key.id || headers.Digest !== `SHA-256=${createHash("sha256").update(body).digest("base64")}`) return false;
    unb64(headers["Express-Request-Nonce"], 32);
    const target = new URL(url);
    const canonical = `(request-target): post ${target.pathname}${target.search}\n(created): ${match[3]}\nexpress-request-nonce: ${headers["Express-Request-Nonce"]}\ndigest: ${headers.Digest}`;
    return nacl.sign.detached.verify(Buffer.from(canonical), unb64(match[2], 64), unb64(key.public, 32));
  } catch { return false; }
}
export function sharedKey(id: string, secret: unknown): AccountKey {
  const key = unb64(secret, 32);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SessionError("QR_KEYS_MISSING");
  return { id, secret: b64(key), public: b64(nacl.box.keyPair.fromSecretKey(key).publicKey) };
}
export function openRegistration(payload: unknown, key: Uint8Array): any {
  const bytes = unb64(payload);
  const plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), key);
  if (!plain) throw new SessionError("QR_DECRYPT_FAILED");
  try { return JSON.parse(Buffer.from(plain).toString("utf8")); }
  catch { throw new SessionError("QR_DECRYPT_FAILED"); }
}
export function boxSeal(data: Uint8Array, recipient: Uint8Array, sender: Uint8Array): string {
  const nonce = randomBytes(24);
  return b64(Buffer.concat([nonce, nacl.box(data, nonce, recipient, sender)]));
}
export interface WireMessage {
  sync_id: string; group_chat_id: string; payload: string; sender: string; sender_key_id: string;
  inserted_at?: string; event_type: string;
  key: { key_id: string; key: string; algo: string };
  signature?: { sign: string; sign_key_id: string; sign_algo: string };
}
export interface PublicKey { id: string; body: string; kind: string; user_huid: string }
export async function messageKey(message: WireMessage, own: AccountKey, keys: PublicKey[]): Promise<Uint8Array> {
  await sodium.ready;
  if (message.key.key_id !== own.id || message.key.algo !== "xsalsa20:xchacha20_aead_ietf") throw new SessionError("CRYPTO_KEY_MISMATCH");
  // Shared history can be rewrapped by CTS's REST service. That wrapping key
  // belongs to the service; the original author is authenticated by its signature.
  const sender = keys.find(k => k.id === message.sender_key_id && (k.kind === "rest" || (k.kind === "cts" && k.user_huid === message.sender)));
  if (!sender) throw new SessionError("CRYPTO_KEY_MISSING");
  if (sender.kind === "rest" && !message.signature) throw new SessionError("CRYPTO_SIGNATURE_INVALID");
  if (message.signature) {
    const sig = message.signature; const signing = keys.find(k => k.id === sig.sign_key_id && k.user_huid === message.sender && k.kind === "ed25519");
    if (!signing || sig.sign_algo !== "ed25519" || !nacl.sign.detached.verify(Buffer.from(message.payload), unb64(sig.sign, 64), unb64(signing.body, 32))) throw new SessionError("CRYPTO_SIGNATURE_INVALID");
  }
  const wrapped = unb64(message.key.key);
  const symmetric = nacl.box.open(wrapped.subarray(24), wrapped.subarray(0, 24), unb64(sender.body, 32), unb64(own.secret, 32));
  if (!symmetric) throw new SessionError("CRYPTO_DECRYPT_FAILED");
  return symmetric;
}
export async function decryptPayload(message: WireMessage, own: AccountKey, keys: PublicKey[]): Promise<Record<string, any>> {
  const symmetric = await messageKey(message, own, keys);
  try {
    const payload = unb64(message.payload);
    const clear = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, payload.subarray(24), Buffer.from(`${message.group_chat_id}:${message.sync_id}`), payload.subarray(0, 24), symmetric);
    const parsed = JSON.parse(Buffer.from(clear).toString("utf8"));
    if (parsed.group_chat_id && parsed.group_chat_id !== message.group_chat_id) throw new Error();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new SessionError("CRYPTO_DECRYPT_FAILED"); }
  finally { symmetric.fill(0); }
}
export async function decryptMessage(message: WireMessage, own: AccountKey, keys: PublicKey[]): Promise<string> {
  const parsed = await decryptPayload(message, own, keys);
  return typeof parsed.body === "string" ? parsed.body : "";
}
export async function encryptMessage(chatId: string, text: string, bundle: AuthBundle, participants: PublicKey[]) {
  const symmetric = randomBytes(32);
  try { return await encryptPayload(chatId, {type: "text", body: text}, bundle, participants, randomUUID(), symmetric); }
  finally { symmetric.fill(0); }
}
export async function encryptPayload(chatId: string, data: Record<string, unknown>, bundle: AuthBundle, participants: PublicKey[], syncId: string, symmetric: Uint8Array) {
  await sodium.ready;
  if (!participants.length || participants.some(k => k.kind !== "cts")) throw new SessionError("CRYPTO_KEY_MISSING");
  const nonce = randomBytes(24);
    const keys = participants.map(k => ({ key_id: k.id, key: boxSeal(symmetric, unb64(k.body, 32), unb64(bundle.ctsKey.secret, 32)), algo: "xsalsa20:xchacha20_aead_ietf" }));
    const clear = JSON.stringify({ ...data, msg_id: randomUUID(), from: bundle.accountId, timestamp: new Date().toISOString(), group_chat_id: chatId, lat: 0, lng: 0, link_meta_disabled: false, stealth_forwarding: false });
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(Buffer.from(clear), Buffer.from(`${chatId}:${syncId}`), null, nonce, symmetric);
    const payload = b64(Buffer.concat([nonce, sealed]));
    return { group_chat_id: chatId, sync_id: syncId, keys, payload, signature: { sign: signature(payload, bundle.signing), sign_key_id: bundle.signing.id, sign_algo: "ed25519" } };
}
