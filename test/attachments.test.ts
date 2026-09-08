import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { attachmentInputSchema, readAttachmentSource, safeFileName, MAX_ATTACHMENT_BYTES, saveAttachment, type AttachmentInput, type AttachmentSource } from "../src/attachments.js";
import { encryptFile, decryptFile, fileHash, FILE_CHUNK_BYTES } from "../src/session/file-crypto.js";
import { attachmentRoute, attachmentMetadata, sendAttachment, downloadAttachment } from "../src/session/attachment-client.js";
import { decryptPayload, encryptPayload, b64, type WireMessage } from "../src/session/crypto.js";
import { fixture } from "./session-fixtures.js";
import { SessionHttp } from "../src/session/http.js";
import { DEFAULT_CONFIG } from "../src/session/types.js";
import { MockExpressAdapter } from "../src/adapter/mock.js";
import { ExpressService } from "../src/service.js";
import { createSafeLogger } from "../src/logger.js";
import { DirectClient } from "../src/session/direct.js";

const quiet = () => createSafeLogger(new Writable({write(_c, _e, cb) {cb();}}));
test("stream file round-trip crosses native 2 MiB chunk boundary and rejects tampering, truncation, wrong hash/key/size", async () => {
  const bytes = randomBytes(FILE_CHUNK_BYTES + 63), key = randomBytes(32), hash = await fileHash(bytes);
  const encrypted = await encryptFile(bytes, key);
  assert.deepEqual(await decryptFile(encrypted, key, bytes.length, hash, FILE_CHUNK_BYTES), bytes);
  const changed = Buffer.from(encrypted); changed[32] = changed[32]! ^ 1;
  for (const data of [changed, encrypted.subarray(0, encrypted.length - 1), Buffer.concat([encrypted, Buffer.from([0])])]) await assert.rejects(decryptFile(data, key, bytes.length, hash, FILE_CHUNK_BYTES));
  await assert.rejects(decryptFile(encrypted, randomBytes(32), bytes.length, hash, FILE_CHUNK_BYTES));
  await assert.rejects(decryptFile(encrypted, key, bytes.length, b64(randomBytes(32)), FILE_CHUNK_BYTES));
  await assert.rejects(decryptFile(encrypted, key, bytes.length + 1, hash, FILE_CHUNK_BYTES));
  await assert.rejects(decryptFile(encrypted, key, bytes.length, hash, 1024));
});
test("local file boundary rejects symlink, directory, empty/oversized file, fake image and traversal filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "express-file-test-"));
  const input: AttachmentInput = {chatId: randomUUID(), kind: "document", caption: "", selfOnly: true, filePath: join(dir, "данные.txt")};
  try {
    await writeFile(input.filePath, "Привет!\nUTF-8 ✓\n");
    const read = await readAttachmentSource(input); assert.equal(read.bytes.toString(), "Привет!\nUTF-8 ✓\n");
    await symlink(input.filePath, join(dir, "link.txt"));
    for (const path of [join(dir, "link.txt"), dir, "relative.txt"]) await assert.rejects(readAttachmentSource({...input, filePath: path}));
    await assert.rejects(readAttachmentSource({...input, kind: "image"}));
    await writeFile(input.filePath, ""); await assert.rejects(readAttachmentSource(input));
    await writeFile(input.filePath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)); await assert.rejects(readAttachmentSource(input));
    for (const name of ["../x", "x/y", "x\\y", "..", "x\n", "a".repeat(241)]) assert.throws(() => safeFileName(name));
  } finally {await rm(dir, {recursive: true, force: true});}
});
test("attachment confirmation binds bytes/target/caption/kind and caller; consume once even on failure", async () => {
  class Adapter extends MockExpressAdapter {
    calls = 0;
    async getChatInfo(chatId: string) { return {chatId, title: "Synthetic", type: "group_chat", memberCount: 1, onlySelf: true}; }
    async sendAttachment(_input: AttachmentInput, _source: AttachmentSource, _id: string): Promise<any> { this.calls++; throw new Error("secret-error"); }
  }
  const adapter = new Adapter(), a = new ExpressService({adapter, logger: quiet()}), b = new ExpressService({adapter, logger: quiet()});
  const dir = await mkdtemp(join(tmpdir(), "express-confirm-test-"));
  const input = attachmentInputSchema.parse({chatId: randomUUID(), filePath: join(dir, "file.txt"), kind: "document", selfOnly: true});
  try {
    await writeFile(input.filePath, "original");
    const prepared = await a.prepareAttachment(input);
    await assert.rejects(b.sendAttachment(input, prepared.confirmationToken), /unknown/i);
    for (const changed of [{...input, chatId: randomUUID()}, {...input, caption: "different"}, {...input, selfOnly: false}]) await assert.rejects(a.sendAttachment(changed, prepared.confirmationToken), /exact/i);
    await writeFile(input.filePath, "modified"); await assert.rejects(a.sendAttachment(input, prepared.confirmationToken), /exact/i); assert.equal(adapter.calls, 0);
    await writeFile(input.filePath, "original");
    const sent = await a.sendAttachment(input, prepared.confirmationToken); assert.equal(sent.outcome, "unknown"); assert.equal(sent.retryAttempted, false); assert.ok(sent.messageId); assert.equal(JSON.stringify(sent).includes("secret-error"), false);
    await assert.rejects(a.sendAttachment(input, prepared.confirmationToken), /unknown/i); assert.equal(adapter.calls, 1);
  } finally {await a.close(); await b.close(); await rm(dir, {recursive: true, force: true});}
});
test("strict attachment address prevents external origin, credentials, non-file APIs and traversal", () => {
  const origin = "https://chat.example.com", chatId = randomUUID(), path = `/uploads/files/${chatId}/${"a".repeat(32)}.bin`;
  assert.equal(attachmentRoute(path, origin, chatId), path);
  for (const url of ["http://chat.example.com/api/v2/file_service/x", "https://evil.test/api/v2/file_service/x", "//evil.test/x", "https://u:p@chat.example.com/api/v2/file_service/x", "/api/v1/ad_integration/token/refresh", "/api/v2/file_service/%2e%2e/x", "/api/v2/file_service/x#fragment", "file:///etc/passwd"]) assert.throws(() => attachmentRoute(url, origin, chatId));
});
test("multipart sends retain browser profile headers but let fetch choose content-type boundary; redirects denied", async () => {
  let calls = 0;
  const http = new SessionHttp(DEFAULT_CONFIG, async (_url, init) => { calls++; assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).has("content-type"), false); assert.ok(init?.body instanceof FormData); return new Response(JSON.stringify({result: {}})); });
  const form = new FormData(); form.set("content", new Blob(["synthetic"]), "x.txt");
  await http.json(DEFAULT_CONFIG.ctsOrigin, "/api/v2/file_service/files/groupchat_file/" + randomUUID(), {method: "POST", body: form});
  assert.equal(calls, 1);
});

test("personal native attachment transport sends once and downloads by signed message; wrong chat/oversized/corrupt response rejected", async () => {
  const bundle = fixture(), chatId = randomUUID(), syncId = randomUUID();
  const keys = [{id: bundle.ctsKey.id, body: bundle.ctsKey.public, kind: "cts", user_huid: bundle.accountId}, {id: bundle.signing.id, body: bundle.signing.public, kind: "ed25519", user_huid: bundle.accountId}];
  const source: AttachmentSource = {bytes: Buffer.from("UTF-8 тест ✓\n"), kind: "document", fileName: "test.txt", mimeType: "text/plain", size: Buffer.byteLength("UTF-8 тест ✓\n"), sha256: "unused"};
  let uploaded: Buffer, wire: WireMessage, writes = 0, uploads = 0, downloads = 0, corrupt = false, oversized = false, self = true, denyFor = 0;
  const http = new SessionHttp(DEFAULT_CONFIG, async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      uploads++; const form = init.body as FormData; assert.ok(form instanceof FormData);
      const meta = JSON.parse(String(form.get("meta"))); uploaded = Buffer.from(await (form.get("content") as Blob).arrayBuffer());
      assert.equal(meta.sync_id, syncId); assert.equal(meta.kind, "document"); assert.equal(meta.file_encryption_algo, "stream"); assert.equal(meta.sender_key_id, bundle.ctsKey.id);
      return new Response(JSON.stringify({result: {id: randomUUID(), content: `/uploads/files/${chatId}/${"a".repeat(32)}.bin`, meta: {file_hash: meta.file_hash}}}));
    }
    assert.equal(route, `/uploads/files/${chatId}/${"a".repeat(32)}.bin`); downloads++;
    if (denyFor-- > 0) return new Response(null, {status: 403});
    const data = Buffer.from(uploaded); if (corrupt) data[30] = data[30]! ^ 1;
    return new Response(data, {headers: oversized ? {"content-length": String(MAX_ATTACHMENT_BYTES * 2)} : {}});
  });
  const client = {
    auth: {credentials: async () => bundle, authenticated() {}}, http,
    info: async () => ({chat_type: "group_chat", member_huids: self ? [bundle.accountId] : [bundle.accountId, randomUUID()]}),
    recipientKeys: async () => [keys[0]!], target: async () => ({}), keys: async () => keys,
    rest: async () => ({info: [wire]}), history: async () => [wire],
    decrypt: async () => {const clear = await decryptPayload(wire, bundle.ctsKey, keys); return [{text: clear.body, attachment: attachmentMetadata(clear)}];},
    socket: {request: async (_topic: string, _event: string, message: any) => {writes++; wire = {...message, sender: bundle.accountId, sender_key_id: bundle.ctsKey.id, key: message.keys[0], event_type: "message_new"}; return {};}}
  } as unknown as DirectClient;
  const input: AttachmentInput = {chatId, filePath: "/unused", kind: "document", caption: "caption", selfOnly: true};
  self = false; const refused = await sendAttachment(client, input, source, syncId); assert.equal(refused.error?.code, "SELF_CHAT_REQUIRED"); assert.equal(uploads, 0); self = true;
  const sent = await sendAttachment(client, input, source, syncId); assert.equal(sent.ok, true); assert.equal(writes, 1); assert.equal(uploads, 1);
  const result = await downloadAttachment(client, chatId, syncId); assert.deepEqual(result.bytes, source.bytes);
  await assert.rejects(downloadAttachment(client, randomUUID(), syncId)); assert.equal(downloads, 1);
  denyFor = 1; const delayed = await downloadAttachment(client, chatId, syncId); assert.deepEqual(delayed.bytes, source.bytes); assert.equal(downloads, 3);
  denyFor = 10; await assert.rejects(downloadAttachment(client, chatId, syncId), /ATTACHMENT_ACCESS_DENIED/); assert.equal(downloads, 5); denyFor = 0;
  corrupt = true; await assert.rejects(downloadAttachment(client, chatId, syncId)); corrupt = false;
  oversized = true; await assert.rejects(downloadAttachment(client, chatId, syncId), /LARGE/);
  assert.equal(writes, 1); assert.equal(uploads, 1);
});

test("download storage creates unique private files and never overwrites", async () => {
  const a = await saveAttachment(Buffer.from("first"), "same.txt"), b = await saveAttachment(Buffer.from("second"), "same.txt");
  try {assert.notEqual(a.path, b.path); assert.equal((await stat(a.path)).mode & 0o777, 0o600); assert.equal((await stat(join(a.path, ".."))).mode & 0o777, 0o700);}
  finally {await rm(join(a.path, ".."), {recursive: true, force: true}); await rm(join(b.path, ".."), {recursive: true, force: true});}
});

test("one inaccessible history event does not suppress valid messages and never claims verified attribution", async () => {
  const bundle = fixture(), chatId = randomUUID();
  const keys = [{id: bundle.ctsKey.id, body: bundle.ctsKey.public, kind: "cts", user_huid: bundle.accountId}, {id: bundle.signing.id, body: bundle.signing.public, kind: "ed25519", user_huid: bundle.accountId}];
  const envelope = await encryptPayload(chatId, {type: "text", body: "readable"}, bundle, [keys[0]!], randomUUID(), randomBytes(32));
  const wire = {...envelope, sender: bundle.accountId, sender_key_id: bundle.ctsKey.id, key: envelope.keys[0], event_type: "message_new"};
  const missing = {...wire, sync_id: randomUUID(), key: undefined};
  const forged = {...wire, signature: {...wire.signature, sign: b64(randomBytes(64))}};
  const client = {keys: async () => keys, auth: {credentials: async () => bundle}};
  const output = await DirectClient.prototype.decrypt.call(client as any, [missing, wire, forged] as any);
  assert.equal(output[0]?.decryptionError, "CRYPTO_KEY_MISSING"); assert.equal(output[0]?.senderId, undefined); assert.equal(output[0]?.isSelf, undefined);
  assert.equal(output[1]?.text, "readable"); assert.equal(output[1]?.isSelf, true);
  assert.equal(output[2]?.decryptionError, "CRYPTO_SIGNATURE_INVALID"); assert.equal(output[2]?.text, ""); assert.equal(output[2]?.isSelf, undefined);
});

test("native image ranged upload uses one create and exact nonreplayed ranges, rejects hostile location and ambiguous range", async () => {
  const {uploadImage} = await import("../src/session/file-upload.js");
  const input = {chatId: randomUUID(), fileName: "image.png", mimeType: "image/png", meta: {}, content: Buffer.alloc(6_291_508, 1), preview: Buffer.from("encrypted-thumbnail")};
  const seen: {route: string; shape: string | null; range: string | null; size: number}[] = [];
  const url = `/api/v2/file_service/resumable/${randomUUID()}`;
  const http = new SessionHttp(DEFAULT_CONFIG, async (address, init) => {
    const route = new URL(String(address)).pathname, headers = new Headers(init?.headers);
    if (route.endsWith("/resumable")) {assert.equal(headers.get("upload-shapes"), `content=${input.content.length};preview=${input.preview.length},image/jpeg`); return new Response(null, {status: 201, headers: {location: url}});}
    const bytes = init!.body as Uint8Array;seen.push({route, shape: headers.get("upload-shape"), range: headers.get("upload-range"), size: bytes.length});
    return headers.get("upload-shape") === "preview" ? new Response(JSON.stringify({result: {ok: true}}), {status: 201}) : new Response(null, {status: 202});
  });
  assert.deepEqual(await uploadImage(http, DEFAULT_CONFIG.ctsOrigin, "synthetic", input), {ok: true});
  assert.deepEqual(seen.map(r => [r.shape, r.range, r.size]), [["content", "bytes=0-6291506", 6291507], ["content", "bytes=6291507-6291507", 1], ["preview", "bytes=0-18", 19]]);
  let calls = 0;
  const bad = new SessionHttp(DEFAULT_CONFIG, async () => {calls++; return new Response(null, {status: 201, headers: {location: "https://evil.test" + url}});});
  await assert.rejects(uploadImage(bad, DEFAULT_CONFIG.ctsOrigin, "synthetic", input)); assert.equal(calls, 1);
  calls = 0;
  const lost = new SessionHttp(DEFAULT_CONFIG, async () => {calls++; if(calls === 1) return new Response(null, {status: 201, headers: {location: url}}); throw new Error("lost");});
  await assert.rejects(uploadImage(lost, DEFAULT_CONFIG.ctsOrigin, "synthetic", input)); assert.equal(calls, 2);
});

test("image uses native media metadata, JPEG thumbnail and image message while preserving original PNG", {skip: process.platform !== "darwin"}, async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const bundle = fixture(), chatId = randomUUID(), syncId = randomUUID(), location = `/api/v2/file_service/resumable/${randomUUID()}`;
  const {pngSize} = await import("../src/attachments.js");
  const source: AttachmentSource = {bytes, kind: "image", fileName: "test.png", mimeType: "image/png", size: bytes.length, sha256: "unused", ...pngSize(bytes)};
  const keys = [{id: bundle.ctsKey.id, body: bundle.ctsKey.public, kind: "cts", user_huid: bundle.accountId}, {id: bundle.signing.id, body: bundle.signing.public, kind: "ed25519", user_huid: bundle.accountId}];
  const file = `/uploads/files/${chatId}/${"b".repeat(32)}.png`; const preview = `/uploads/files/${chatId}/${"c".repeat(32)}.jpg`;
  let content: Buffer, thumbnail: Buffer, meta: any, wire: WireMessage, sends = 0;
  const http = new SessionHttp(DEFAULT_CONFIG, async (url, init) => {
    const route = new URL(String(url)).pathname, headers = new Headers(init?.headers);
    if (route.endsWith("/resumable")) {
      meta = JSON.parse(String(init?.body)).meta; assert.equal(meta.kind, "media"); assert.equal(meta.sync_id, syncId);
      assert.match(headers.get("upload-shapes")!, /,image\/jpeg$/);
      return new Response(null, {status: 201, headers: {location}});
    }
    assert.equal(route, location);
    if(headers.get("upload-shape") === "content") {content = Buffer.from(init!.body as Uint8Array); return new Response(null, {status: 202});}
    thumbnail = Buffer.from(init!.body as Uint8Array);
    return new Response(JSON.stringify({result: {id: randomUUID(), content: file, content_shapes: {preview}, meta: {file_hash: meta.file_hash}}}), {status: 201});
  });
  const client = {auth: {credentials: async () => bundle}, http, info: async () => ({chat_type: "group_chat", member_huids: [bundle.accountId]}), recipientKeys: async () => [keys[0]], history: async () => [wire], decrypt: async () => {const p = await decryptPayload(wire, bundle.ctsKey, keys);return [{text: p.body, attachment: attachmentMetadata(p)}];}, socket: {request: async (_t: string, _e: string, message: any) => {sends++; wire = {...message, sender: bundle.accountId, sender_key_id: bundle.ctsKey.id, key: message.keys[0], event_type: "message_new"};}}} as unknown as DirectClient;
  const result = await sendAttachment(client, {chatId, kind: "image", filePath: "/unused", caption: "image test", selfOnly: true}, source, syncId);
  assert.equal(result.ok, true); assert.equal(sends, 1);
  const {messageKey} = await import("../src/session/crypto.js");
  const key = await messageKey(wire!, bundle.ctsKey, keys);
  assert.deepEqual(await decryptFile(content!, key, bytes.length, await fileHash(bytes), FILE_CHUNK_BYTES), bytes);
  const sodium = (await import("libsodium-wrappers-sumo")).default;
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(thumbnail!.subarray(0,24), key);
  const thumb = sodium.crypto_secretstream_xchacha20poly1305_pull(state, thumbnail!.subarray(24), null);
  assert.ok(thumb); assert.equal(thumb.message[0], 0xff); assert.equal(thumb.message[1], 0xd8); key.fill(0);
});
