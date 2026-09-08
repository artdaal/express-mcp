import {SessionHttp, readJson, resultOf} from "./http.js";
import {SessionError} from "./types.js";
import {MAX_ENCRYPTED_FILE_BYTES} from "./file-crypto.js";
const UPLOAD_PART_BYTES = 6_291_507;
export function uploadRoute(value: string, origin: string) {
  let url: URL;
  try {url = new URL(value, origin);} catch {throw new SessionError("UPSTREAM_ORIGIN_DENIED");}
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || /[\\\x00-\x20%]/.test(value) || !/^\/api\/v2\/file_service\/resumable\/[a-zA-Z0-9_-]{16,128}$/.test(url.pathname)) throw new SessionError("UPSTREAM_ORIGIN_DENIED");
  return url.pathname;
}
/** Each range is submitted once. No HEAD/retry/resume after an uncertain write. */
export async function uploadImage(http: SessionHttp, origin: string, token: string, input: {chatId: string; fileName: string; mimeType: string; meta: object; content: Buffer; preview: Buffer; onPhase?: (phase: string) => void}) {
  if (input.content.length > MAX_ENCRYPTED_FILE_BYTES || input.preview.length > 1024 * 1024 + 41) throw new SessionError("ATTACHMENT_INVALID");
  input.onPhase?.("upload_create");
  const created = await http.response(origin, "/api/v2/file_service/resumable", {method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json", "upload-shapes": `content=${input.content.length};preview=${input.preview.length},image/jpeg`}, body: JSON.stringify({subject: "groupchat_file", subject_id: input.chatId, visible: true, file_name: input.fileName, mime_type: input.mimeType, meta: input.meta})});
  if (!created.ok) throw await http.fileFailure(created);
  const location = created.headers.get("location"); await created.body?.cancel();
  if (!location) throw new SessionError("UNSUPPORTED_PROTOCOL");
  const route = uploadRoute(location, origin);
  let result: any;
  for (const [shape, bytes] of [["content", input.content], ["preview", input.preview]] as const) {
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_PART_BYTES) {
      const end = Math.min(bytes.length, offset + UPLOAD_PART_BYTES);
      input.onPhase?.(`upload_${shape}`);
      const response = await http.response(origin, route, {method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "upload-shape": shape, "upload-range": `bytes=${offset}-${end - 1}`}, body: new Uint8Array(bytes.subarray(offset, end))});
      const last = shape === "preview" && end === bytes.length;
      if (response.status !== (last ? 201 : 202)) {if (!response.ok) throw await http.fileFailure(response); await response.body?.cancel(); throw new SessionError("UNSUPPORTED_PROTOCOL");}
      if (last) {const body = await readJson(response); if (body?.status === "error") throw new SessionError("UPSTREAM_REJECTED"); result = resultOf(body);}
      else await response.body?.cancel();
    }
  }
  return result;
}
