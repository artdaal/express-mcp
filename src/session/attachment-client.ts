import {jpegPreview} from "./image-preview.js";
import {uploadImage} from "./file-upload.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DirectClient } from "./direct.js";
import type { AttachmentInput, AttachmentSource, AttachmentSendResult, AttachmentMetadata } from "../attachments.js";
import { MAX_ATTACHMENT_BYTES, safeFileName } from "../attachments.js";
import { safeErrorBody } from "../errors.js";
import { SessionError } from "./types.js";
import { decryptPayload, encryptPayload, messageKey, type WireMessage } from "./crypto.js";
import { encryptFile, decryptFile, fileHash, FILE_CHUNK_BYTES, MAX_ENCRYPTED_FILE_BYTES } from "./file-crypto.js";

const attachmentSchema = z.object({file: z.string().min(1).max(4096), file_name: z.string().min(1).max(240), file_mime_type: z.string().min(1).max(128), file_size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES), file_hash: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), chunk_size: z.literal(FILE_CHUNK_BYTES), file_encryption_algo: z.literal("stream")});
export function attachmentMetadata(clear: Record<string, any>): AttachmentMetadata | undefined {
  if (!["document", "image"].includes(clear.type)) return undefined;
  const result = attachmentSchema.safeParse(clear.payload);
  if (!result.success) return undefined;
  const p = result.data;
  try { safeFileName(p.file_name); } catch { return undefined; }
  return {kind: clear.type, fileName: p.file_name, mimeType: p.file_mime_type, size: p.file_size};
}
/** Only authenticated file-service resources, never a caller-provided URL. */
export function attachmentRoute(value: string, origin: string, chatId: string) {
  let url: URL;
  try { url = new URL(value, origin); } catch { throw new SessionError("UPSTREAM_ORIGIN_DENIED"); }
  if (url.origin !== origin || url.username || url.password || url.hash || /[\\\x00-\x20]/.test(value) || /%2e|%2f|%5c/i.test(value) || !/^\/uploads\/files\/[0-9a-f-]{36}\/[0-9a-f]{32}\.(?:bin|png|jpg)$/.test(url.pathname) || url.pathname.split("/")[3] !== chatId) throw new SessionError("UPSTREAM_ORIGIN_DENIED");
  return url.pathname + url.search;
}
export async function sendAttachment(client: DirectClient, input: AttachmentInput, source: AttachmentSource, syncId: string): Promise<AttachmentSendResult> {
  const symmetric = randomBytes(32); let phase = "preflight";
  try {
    const info = await client.info(input.chatId);
    const bundle = await client.auth.credentials();
    if (input.selfOnly && (info.chat_type !== "group_chat" || info.member_huids?.length !== 1 || info.member_huids[0] !== bundle.accountId)) throw new SessionError("SELF_CHAT_REQUIRED");
    const keys = await client.recipientKeys(info);
    const origin = client.http.authorizeCtsOrigin(bundle.ctsOrigin);
    const hash = await fileHash(source.bytes);
    const encrypted = await encryptFile(source.bytes, symmetric);
    // Generate wrapped keys before upload; the same symmetric key protects the message.
    const envelope = await encryptPayload(input.chatId, {type: input.kind, body: input.caption}, bundle, keys, syncId, symmetric);
    const meta = {keys: envelope.keys, sync_id: syncId, kind: input.kind === "image" ? "media" : "document", file_hash: hash, chunk_size: FILE_CHUNK_BYTES, file_encryption_algo: "stream", sender_key_id: bundle.ctsKey.id};
    let result: any;
    if (input.kind === "image") {
      const previewBytes = await jpegPreview(source.bytes);
      let preview: Buffer;
      try {preview = await encryptFile(previewBytes, symmetric);} finally {previewBytes.fill(0);}
      phase = "upload";
      result = await uploadImage(client.http, origin, bundle.accessToken, {chatId: input.chatId, fileName: source.fileName, mimeType: source.mimeType, meta, content: encrypted, preview, onPhase: value => {phase = value;}});
    } else {
      const form = new FormData();
      form.set("file_name", source.fileName); form.set("mime_type", source.mimeType);
      form.set("content", new Blob([new Uint8Array(encrypted)], {type: "application/octet-stream"}), source.fileName);
      form.set("meta", JSON.stringify(meta));
      phase = "upload";
      result = await client.http.json(origin, `/api/v2/file_service/files/groupchat_file/${input.chatId}`, {method: "POST", headers: {Authorization: `Bearer ${bundle.accessToken}`}, body: form});
    }
    phase = "upload_metadata";
    if (!result || typeof result.content !== "string" || result.meta?.file_hash !== hash) throw new SessionError("UNSUPPORTED_PROTOCOL");
    attachmentRoute(result.content, origin, input.chatId);
    const preview = result.content_shapes?.preview;
    if (preview !== undefined && preview !== null) attachmentRoute(preview, origin, input.chatId);
    const payload = {file: result.content, file_name: source.fileName, file_size: source.size, file_hash: hash, file_mime_type: source.mimeType, chunk_size: FILE_CHUNK_BYTES, file_encryption_algo: "stream", ...(result.id && z.string().uuid().safeParse(result.id).success ? {file_id: result.id} : {}), ...(typeof preview === "string" ? {file_preview: preview, file_preview_width: Math.max(1, Math.round(source.width! * Math.min(1, 512 / Math.max(source.width!, source.height!)))), file_preview_height: Math.max(1, Math.round(source.height! * Math.min(1, 512 / Math.max(source.width!, source.height!))))} : {})};
    const message = await encryptPayload(input.chatId, {type: input.kind, body: input.caption, payload}, bundle, keys, syncId, symmetric);
    phase = "message";
    await client.socket.request(`groupchat:${input.chatId}`, "message_new", message);
    phase = "verify";
    const events = await client.history(input.chatId, 50);
    const event = events.find(e => e.sync_id === syncId && e.payload === message.payload);
    if (!event) throw new SessionError("SEND_OUTCOME_UNKNOWN");
    const readback = (await client.decrypt([event]))[0];
    if (readback?.text !== input.caption || readback?.attachment?.fileName !== source.fileName || readback.attachment.size !== source.size || readback.attachment.kind !== source.kind) throw new SessionError("SEND_OUTCOME_UNKNOWN");
    return {ok: true, outcome: "verified", messageId: syncId, tokenConsumed: true, retryAttempted: false};
  } catch (error) {
    return {ok: false, outcome: "unknown", messageId: syncId, tokenConsumed: true, retryAttempted: false, phase, error: safeErrorBody(error).error};
  } finally { symmetric.fill(0); }
}
export async function downloadAttachment(client: DirectClient, chatId: string, messageId: string) {
  await client.target(chatId);
  if (!z.string().uuid().safeParse(messageId).success) throw new SessionError("ATTACHMENT_NOT_FOUND");
  const bundle = await client.auth.credentials();
  const response = await client.rest(`/api/v1/messaging/events/event_info?${new URLSearchParams({key_id: bundle.ctsKey.id, "sync_ids[]": messageId})}`);
  const result = response?.info;
  // Native MPt.info is the event array. Bind both identifiers before decryption or HTTP.
  if (!Array.isArray(result) || result.length !== 1) throw new SessionError("ATTACHMENT_NOT_FOUND");
  const event = result[0] as WireMessage;
  if (event?.sync_id !== messageId || event?.group_chat_id !== chatId || event?.event_type !== "message_new" || !event.key) throw new SessionError("ATTACHMENT_NOT_FOUND");
  const keys = await client.keys([event.sender_key_id, ...(event.signature ? [event.signature.sign_key_id] : [])]);
  const clear = await decryptPayload(event, bundle.ctsKey, keys);
  const metadata = attachmentMetadata(clear);
  if (!metadata) throw new SessionError("ATTACHMENT_NOT_FOUND");
  const parsed = attachmentSchema.parse(clear.payload);
  const origin = client.http.authorizeCtsOrigin(bundle.ctsOrigin);
  const route = attachmentRoute(parsed.file, origin, chatId);
  const key = await messageKey(event, bundle.ctsKey, keys);
  try {
    let response = await client.http.fileResponse(origin, route, bundle.accessToken);
    // A just-published file can briefly return 403 while the session remains valid.
    // One bounded read retry only: never re-upload or resend the message.
    if (response.status === 403) {
      await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 500));
      response = await client.http.fileResponse(origin, route, bundle.accessToken);
    }
    if (!response.ok) { await response.body?.cancel(); throw new SessionError(response.status === 401 ? "UPSTREAM_UNAUTHORIZED" : response.status === 403 ? "ATTACHMENT_ACCESS_DENIED" : "UPSTREAM_REJECTED"); }
    const reader = response.body?.getReader();
    if (!reader) throw new SessionError("UNSUPPORTED_PROTOCOL");
    const declared = Number(response.headers.get("content-length"));
    const maximum = Math.min(MAX_ENCRYPTED_FILE_BYTES, parsed.file_size + Math.ceil(parsed.file_size / FILE_CHUNK_BYTES) * 17 + 24);
    if (declared > maximum) { await reader.cancel(); throw new SessionError("UPSTREAM_RESPONSE_TOO_LARGE"); }
    const parts: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) { await reader.cancel(); throw new SessionError("UPSTREAM_RESPONSE_TOO_LARGE"); } parts.push(part.value); }
    const bytes = await decryptFile(Buffer.concat(parts), key, parsed.file_size, parsed.file_hash, parsed.chunk_size);
    client.auth.authenticated(); return {bytes, metadata};
  } finally { key.fill(0); }
}
