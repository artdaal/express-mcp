import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { configSchema, SessionError } from "./types.js";

export const dataDir = () => join(homedir(), "Library/Application Support/express-mcp");
export const runDir = () => join(dataDir(), "run");
export const socketPath = () => join(runDir(), "session.sock");
export const projectRoot = () => fileURLToPath(new URL("../../../", import.meta.url));
export const helperPath = () => join(projectRoot(), "native/bin/express-keychain");
export const lockHelperPath = () => join(projectRoot(), "native/bin/express-lock");
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new SessionError("IPC_PATH_UNSAFE");
}
export async function checkSocket(path: string) {
  const dir = await lstat(dirname(path)); const info = await lstat(path);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) || !info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new SessionError("IPC_PATH_UNSAFE");
}
export async function loadConfig() {
  try {
    const file = join(dataDir(), "session.json"); const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 4096) throw new SessionError("CONFIG_UNSAFE");
    return configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error: any) { if (error?.code === "ENOENT") throw new SessionError("CONFIG_MISSING"); throw new SessionError("CONFIG_UNSAFE"); }
}
