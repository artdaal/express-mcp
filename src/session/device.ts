import { execFile } from "node:child_process";
import { hostname, platform, release, type } from "node:os";
import { promisify } from "node:util";
import { SessionConfig, SessionError } from "./types.js";

export async function desktopMetadata(config: SessionConfig) {
  if (config.clientProfile === "express-cli-web") {
    // Registration compatibility with IH8E/express-cli 2e58b5f. The login UI
    // explicitly names this profile; no browser engine is launched by it.
    return { app_version: config.appVersion, device: "Chrome 149.0", device_software: "macOS 10.15.7", device_hostname: null, device_meta: { pushes: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, permissions: { notifications: false } }, locale: "ru", manufacturer: "Google", platform: "web", platform_package_id: config.packageId };
  }
  let software = `${type()} ${release()}`;
  if (platform() === "darwin") {
    let version: string;
    try { version = (await promisify(execFile)("/usr/bin/sw_vers", ["-productVersion"], { timeout: 2000, maxBuffer: 1024 })).stdout.trim(); }
    catch { throw new SessionError("DEVICE_METADATA_UNAVAILABLE"); }
    if (!/^\d{1,3}(?:\.\d{1,3}){1,2}$/.test(version)) throw new SessionError("DEVICE_METADATA_UNAVAILABLE");
    software = `macOS ${version}`;
  }
  // Hostname is sent only to the approved Express service, never to diagnostics.
  return { app_version: config.appVersion, device: "Express MCP", device_software: software, device_hostname: hostname(), device_meta: { pushes: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, permissions: { notifications: false } }, locale: "ru", manufacturer: "express-mcp", platform: "desktop", platform_package_id: config.packageId };
}
