import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, writeFile, readFile, stat, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SessionError} from "./types.js";
import {pngSize, MAX_ATTACHMENT_BYTES} from "../attachments.js";
const run = promisify(execFile);
/** Native macOS image decoder; private staging paths and bounded output. Original stays unchanged. */
export async function jpegPreview(png: Buffer) {
  if (process.platform !== "darwin" || png.length > MAX_ATTACHMENT_BYTES) throw new SessionError("ATTACHMENT_INVALID");
  pngSize(png);
  const dir = await mkdtemp(join(tmpdir(), "express-preview-"));
  try {
    const source = join(dir, "input.png"), dest = join(dir, "preview.jpg");
    await writeFile(source, png, {mode: 0o600, flag: "wx"});
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "512", source, "--out", dest], {timeout: 10_000, maxBuffer: 16_384});
    const info = await stat(dest);
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) throw new Error();
    const bytes = await readFile(dest);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error();
    return bytes;
  } catch { throw new SessionError("ATTACHMENT_INVALID"); }
  finally {await rm(dir, {recursive: true, force: true});}
}
