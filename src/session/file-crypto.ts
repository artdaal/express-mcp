import sodium from "libsodium-wrappers-sumo";
import { b64 } from "./crypto.js";
import { SessionError } from "./types.js";
import { MAX_ATTACHMENT_BYTES } from "../attachments.js";
export const FILE_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_ENCRYPTED_FILE_BYTES = MAX_ATTACHMENT_BYTES + Math.ceil(MAX_ATTACHMENT_BYTES / FILE_CHUNK_BYTES) * 17 + 24;
export async function fileHash(bytes: Uint8Array) { await sodium.ready; return b64(sodium.crypto_generichash(32, bytes, null)); }
export async function encryptFile(bytes: Uint8Array, key: Uint8Array): Promise<Buffer> {
  await sodium.ready;
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || key.length !== 32) throw new SessionError("ATTACHMENT_INVALID");
  const {state, header} = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const parts: Uint8Array[] = [header];
  for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + FILE_CHUNK_BYTES);
    parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, bytes.subarray(offset, end), null, end === bytes.length ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE));
  }
  return Buffer.concat(parts);
}
export async function decryptFile(bytes: Buffer, key: Uint8Array, size: number, hash: string, chunkSize: number): Promise<Buffer> {
  await sodium.ready;
  const chunks = Math.ceil(size / FILE_CHUNK_BYTES);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES || chunkSize !== FILE_CHUNK_BYTES || bytes.length !== size + chunks * 17 + 24 || key.length !== 32) throw new SessionError("ATTACHMENT_INVALID");
  const plain: Uint8Array[] = [];
  try {
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(bytes.subarray(0, 24), key);
    for (let offset = 24; offset < bytes.length; offset += FILE_CHUNK_BYTES + 17) {
      const end = Math.min(bytes.length, offset + FILE_CHUNK_BYTES + 17);
      const part = sodium.crypto_secretstream_xchacha20poly1305_pull(state, bytes.subarray(offset, end), null);
      const expected = end === bytes.length ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      if (!part || part.tag !== expected) throw new Error();
      plain.push(part.message);
    }
    const result = Buffer.concat(plain);
    if (result.length !== size || await fileHash(result) !== hash) { result.fill(0); throw new Error(); }
    return result;
  } catch { throw new SessionError("ATTACHMENT_INTEGRITY_FAILED"); }
  finally { for (const p of plain) p.fill(0); }
}
