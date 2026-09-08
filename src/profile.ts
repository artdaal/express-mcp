import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  PROFILE_LOCK_FILENAME,
  PROFILE_MARKER_FILENAME,
} from "./constants.js";
import { ExpressError } from "./errors.js";

const MARKER_CONTENT = `${JSON.stringify({
  owner: "express-mcp",
  formatVersion: 1,
})}\n`;

export interface ProfileResolutionOptions {
  flagValue?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

export interface ProfileLease {
  readonly profileDir: string;
  readonly permissionWarning: boolean;
  release(): Promise<void>;
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") {
    return homeDirectory;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

export function defaultProfileDir(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === "darwin") {
    return path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "express-mcp",
      "chromium-profile",
    );
  }
  if (platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA ??
      path.join(homeDirectory, "AppData", "Local");
    return path.join(localAppData, "express-mcp", "chromium-profile");
  }
  const stateHome =
    environment.XDG_STATE_HOME ?? path.join(homeDirectory, ".local", "state");
  return path.join(stateHome, "express-mcp", "chromium-profile");
}

export function resolveProfileDir(
  options: ProfileResolutionOptions = {},
): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const selected =
    options.flagValue ??
    environment.EXPRESS_MCP_PROFILE_DIR ??
    defaultProfileDir(platform, environment, homeDirectory);
  return path.resolve(expandHome(selected, homeDirectory));
}

function normalBrowserRoots(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string[] {
  if (platform === "darwin") {
    const appSupport = path.join(
      homeDirectory,
      "Library",
      "Application Support",
    );
    return [
      path.join(appSupport, "Google", "Chrome"),
      path.join(appSupport, "Chromium"),
      path.join(appSupport, "Microsoft Edge"),
    ];
  }
  if (platform === "win32") {
    const local =
      environment.LOCALAPPDATA ??
      path.join(homeDirectory, "AppData", "Local");
    return [
      path.join(local, "Google", "Chrome", "User Data"),
      path.join(local, "Chromium", "User Data"),
      path.join(local, "Microsoft", "Edge", "User Data"),
    ];
  }
  const configHome =
    environment.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config");
  return [
    path.join(configHome, "google-chrome"),
    path.join(configHome, "chromium"),
    path.join(configHome, "microsoft-edge"),
  ];
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function isKnownBrowserProfilePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): boolean {
  return normalBrowserRoots(platform, environment, homeDirectory).some((root) =>
    isWithin(candidate, root),
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function enforceMode(
  target: string,
  mode: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform === "win32") {
    return true;
  }
  try {
    await chmod(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function ensureDedicatedProfile(
  profileDir: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (isKnownBrowserProfilePath(profileDir, platform)) {
    throw new ExpressError("PROFILE_UNSAFE");
  }

  const existed = await pathExists(profileDir);
  if (!existed) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
  } else {
    const info = await lstat(profileDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ExpressError("PROFILE_UNSAFE");
    }
  }

  const markerPath = path.join(profileDir, PROFILE_MARKER_FILENAME);
  const markerExists = await pathExists(markerPath);
  const entries = await readdir(profileDir);
  if (!markerExists && entries.length > 0) {
    throw new ExpressError("PROFILE_UNSAFE");
  }

  if (!markerExists) {
    await writeFile(markerPath, MARKER_CONTENT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } else {
    const marker = await readFile(markerPath, "utf8");
    if (marker !== MARKER_CONTENT) {
      throw new ExpressError("PROFILE_UNSAFE");
    }
  }

  const directoryModeOk = await enforceMode(profileDir, 0o700, platform);
  const markerModeOk = await enforceMode(markerPath, 0o600, platform);
  return !(directoryModeOk && markerModeOk);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function clearStaleLock(lockPath: string): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
    };
    if (typeof data.pid === "number" && processIsAlive(data.pid)) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function acquireLock(
  profileDir: string,
  platform: NodeJS.Platform,
): Promise<{
  nonce: string;
  permissionWarning: boolean;
  release: () => Promise<void>;
}> {
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILENAME);
  const nonce = randomBytes(24).toString("base64url");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ owner: "express-mcp", pid: process.pid, nonce })}\n`,
        "utf8",
      );
      const modeOk = await enforceMode(lockPath, 0o600, platform);

      return {
        nonce,
        permissionWarning: !modeOk,
        release: async () => {
          await handle.close().catch(() => undefined);
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as {
              nonce?: unknown;
            };
            if (current.nonce === nonce) {
              await unlink(lockPath);
            }
          } catch {
            // A missing or replaced lock is never removed blindly.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ExpressError("PROFILE_UNSAFE");
      }
      if (attempt === 0 && (await clearStaleLock(lockPath))) {
        continue;
      }
      throw new ExpressError("PROFILE_IN_USE");
    }
  }
  throw new ExpressError("PROFILE_IN_USE");
}

export function applyRestrictiveUmask(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    process.umask(0o077);
  }
}

export async function acquireProfileLease(
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ProfileLease> {
  const permissionWarning = await ensureDedicatedProfile(profileDir, platform);
  const lock = await acquireLock(profileDir, platform);
  return {
    profileDir,
    permissionWarning: permissionWarning || lock.permissionWarning,
    release: lock.release,
  };
}
