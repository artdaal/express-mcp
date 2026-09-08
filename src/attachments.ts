import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, mkdtemp, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ExpressError } from "./errors.js";
import { dataDir, privateDirectory } from "./session/paths.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const attachmentInputSchema = z.object({
  chatId: z.string().uuid(), filePath: z.string().min(1).max(4096),
  kind: z.enum(["document", "image"]), caption: z.string().max(16_000).default(""),
  selfOnly: z.boolean().default(false),
}).strict();
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export interface AttachmentMetadata { kind: "document" | "image"; fileName: string; mimeType: string; size: number }
export interface AttachmentSource extends AttachmentMetadata { bytes: Buffer; sha256: string; width?: number; height?: number }
export interface AttachmentSendResult { ok: boolean; outcome: "verified" | "unknown"; messageId: string; tokenConsumed: true; retryAttempted: false; phase?: string; error?: {code: string; message: string} }
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function safeFileName(name: string) {
  if (!name || Buffer.byteLength(name) > 240 || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) throw new ExpressError("ATTACHMENT_INVALID");
  return name;
}
export function pngSize(bytes: Buffer) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new ExpressError("ATTACHMENT_INVALID");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16000 || height > 16000 || width * height > 40_000_000) throw new ExpressError("ATTACHMENT_INVALID");
  return {width, height};
}
export async function readAttachmentSource(input: AttachmentInput): Promise<AttachmentSource> {
  if (!isAbsolute(input.filePath)) throw new ExpressError("ATTACHMENT_INVALID");
  const name = safeFileName(basename(input.filePath));
  let file;
  try {
    const link = await lstat(input.filePath);
    if (link.isSymbolicLink()) throw new ExpressError("ATTACHMENT_INVALID");
    file = await open(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || !before.size || before.size > MAX_ATTACHMENT_BYTES) throw new ExpressError("ATTACHMENT_INVALID");
    const buffer = Buffer.alloc(before.size + 1); let total = 0;
    while (total < buffer.length) { const {bytesRead} = await file.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
    const after = await file.stat();
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ExpressError("ATTACHMENT_CHANGED");
    const bytes = buffer.subarray(0, total);
    const mimeType = input.kind === "image" ? "image/png" : ({".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}[extname(name).toLowerCase()] ?? "application/octet-stream");
    return {bytes, sha256: sha256(bytes), fileName: name, mimeType, kind: input.kind, size: total, ...(input.kind === "image" ? pngSize(bytes) : {})};
  } catch (error) { if (error instanceof ExpressError) throw error; throw new ExpressError("ATTACHMENT_INVALID"); }
  finally { await file?.close(); }
}
export function attachmentBinding(input: AttachmentInput, source: Omit<AttachmentSource, "bytes">) {
  return JSON.stringify(["express-attachment-v1", input.chatId, input.filePath, input.kind, input.caption, input.selfOnly, source.fileName, source.mimeType, source.size, source.sha256]);
}
export async function saveAttachment(bytes: Buffer, fileName: string) {
  safeFileName(fileName);
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new ExpressError("ATTACHMENT_INVALID");
  await privateDirectory(dataDir()); const root = join(dataDir(), "downloads"); await privateDirectory(root);
  const directory = await mkdtemp(join(root, "attachment-"));
  const path = join(directory, fileName); let handle;
  try { handle = await open(path, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); return {path, size: bytes.length, sha256: sha256(bytes)}; }
  catch { await rm(directory, {recursive: true, force: true}); throw new ExpressError("ATTACHMENT_WRITE_FAILED"); }
  finally { await handle?.close(); }
}
export const attachmentMessageId = () => randomUUID();
