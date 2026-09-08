import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildNative() {
  if (process.platform !== "darwin") throw new Error("macOS is required for the session broker Keychain and lock helpers.");
  const dir = path.join(root, "native/bin"); await mkdir(dir, {recursive: true, mode: 0o700});
  for (const [source, name] of [["keychain.swift", "express-keychain"], ["session-lock.swift", "express-lock"]]) {
    const file = path.join(root, "native", source); const binary = path.join(dir, name);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    let existing = ""; try { existing = await readFile(binary + ".source-sha256", "utf8"); await readFile(binary); } catch { existing = ""; }
    if (existing === digest) continue;
    await exec("/usr/bin/swiftc", ["-O", file, "-o", binary]);
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", `io.github.express-mcp.${name}`, binary]);
    await chmod(binary, 0o700); await writeFile(binary + ".source-sha256", digest, {mode: 0o600});
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildNative();
