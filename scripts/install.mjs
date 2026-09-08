import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, rename, rm, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildNative } from "./build-native.mjs";
import { privateDirectory, loadConfig } from "../dist/src/session/paths.js";
const exec = promisify(execFile); process.umask(0o077);
const root = fileURLToPath(new URL("../", import.meta.url));
let nodeExecutable = process.execPath;
for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
  try { if (await realpath(candidate) === await realpath(process.execPath)) {nodeExecutable = candidate; break;} } catch {}
}
const base = path.join(homedir(), "Library/Application Support/express-mcp");
const label = "io.github.express-mcp.express-sessiond"; const domain = `gui/${process.getuid()}`;
const plist = path.join(homedir(), "Library/LaunchAgents", label + ".plist");
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
async function optional(file) { try { return await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, value, {mode: 0o600, flag: "wx"}); await rename(temp, file); }
  finally { await rm(temp, {force: true}); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bootout() {
  await exec("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
  for (let i = 0; i < 40; i++) {
    try { await exec("/bin/launchctl", ["print", `${domain}/${label}`]); }
    catch { return; }
    await pause(100);
  }
  throw new Error("Existing LaunchAgent did not unload; no replacement started.");
}
async function bootstrap() {
  for (let i = 0; i < 12; i++) {
    try { await exec("/bin/launchctl", ["bootstrap", domain, plist]); return; }
    catch { if (i === 11) throw new Error("LaunchAgent bootstrap failed."); await pause(250); }
  }
}
if (process.argv[2] === "--restore") {
  const backup = process.argv[3]; if (!backup || !path.isAbsolute(backup)) throw new Error("Pass the absolute backup directory returned by install.");
  const manifest = JSON.parse(await readFile(path.join(backup, "manifest.json"), "utf8"));
  await bootout();
  if (manifest.hadLaunchAgent) { await atomic(plist, await readFile(path.join(backup, "launchagent.plist"))); await bootstrap(); }
  else await rm(plist, {force: true});
  process.stdout.write(JSON.stringify({ok: true, restored: true, credentialsPreserved: true}) + "\n");
} else {
  // Fail before any mutation if the deployment has not been configured.
  await loadConfig(); await buildNative(); await privateDirectory(base); await privateDirectory(path.join(base, "run"));
  await mkdir(path.dirname(plist), {recursive: true});
  const oldPlist = await optional(plist);
  const backup = path.join(base, "backups", `${Date.now()}-${randomUUID()}`); await mkdir(backup, {recursive: true, mode: 0o700});
  if (oldPlist) await writeFile(path.join(backup, "launchagent.plist"), oldPlist, {mode: 0o600});
  await writeFile(path.join(backup, "manifest.json"), JSON.stringify({hadLaunchAgent: Boolean(oldPlist)}), {mode: 0o600});
  const env = {PATH: path.dirname(nodeExecutable) + ":/usr/bin:/bin:/usr/sbin:/sbin"};
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  const body = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[nodeExecutable, path.join(root, "dist/src/cli.js"), "daemon"].map(v => `<string>${xml(v)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>45</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(path.join(base, "run/daemon.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(base, "run/daemon.log"))}</string></dict></plist>`;
  await bootout();
  try {
    await atomic(plist, body); await exec("/usr/bin/plutil", ["-lint", plist]); await bootstrap();
    let running = false;
    for (let i = 0; i < 20; i++) {
      try { const probe = await exec(process.execPath, [path.join(root, "dist/src/cli.js"), "status"], {timeout: 5000}); running = JSON.parse(probe.stdout).status?.session?.brokerState === "running"; } catch {}
      if (running) break; await pause(250);
    }
    if (!running) throw new Error("Broker readiness probe failed.");
  } catch {
    await bootout();
    if (oldPlist) { await atomic(plist, oldPlist); await bootstrap(); } else await rm(plist, {force: true});
    throw new Error("Install failed; previous LaunchAgent restored. Check deployment configuration and Keychain availability.");
  }
  process.stdout.write(JSON.stringify({ok: true, launchAgent: label, backupDirectory: backup, harnessConfigChanged: false}) + "\n");
}
