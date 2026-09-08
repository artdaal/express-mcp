import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PROFILE_MARKER_FILENAME } from "../src/constants.js";
import { ExpressError } from "../src/errors.js";
import {
  acquireProfileLease,
  defaultProfileDir,
  isKnownBrowserProfilePath,
  resolveProfileDir,
} from "../src/profile.js";

test("profile selection honors flag, environment, then platform default", () => {
  const home = path.join(path.sep, "synthetic-home");
  const environment = {
    EXPRESS_MCP_PROFILE_DIR: path.join(home, "from-env"),
    XDG_STATE_HOME: path.join(home, "state"),
    LOCALAPPDATA: path.join(home, "local"),
  };
  assert.equal(
    resolveProfileDir({
      flagValue: path.join(home, "from-flag"),
      environment,
      platform: "linux",
      homeDirectory: home,
    }),
    path.join(home, "from-flag"),
  );
  assert.equal(
    resolveProfileDir({
      environment,
      platform: "linux",
      homeDirectory: home,
    }),
    path.join(home, "from-env"),
  );
  assert.equal(
    defaultProfileDir("darwin", {}, home),
    path.join(
      home,
      "Library",
      "Application Support",
      "express-mcp",
      "chromium-profile",
    ),
  );
  assert.equal(
    defaultProfileDir("linux", {}, home),
    path.join(home, ".local", "state", "express-mcp", "chromium-profile"),
  );
  assert.equal(
    defaultProfileDir("win32", environment, home),
    path.join(home, "local", "express-mcp", "chromium-profile"),
  );
});

test("profile initialization creates marker, enforces modes, and locks exclusively", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "express-profile-test-"));
  const profile = path.join(root, "dedicated");
  const first = await acquireProfileLease(profile);
  try {
    const marker = path.join(profile, PROFILE_MARKER_FILENAME);
    assert.equal(
      JSON.parse(await readFile(marker, "utf8")).owner,
      "express-mcp",
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(profile)).mode & 0o777, 0o700);
      assert.equal((await stat(marker)).mode & 0o777, 0o600);
      await chmod(profile, 0o755);
      await chmod(marker, 0o644);
    }
    await assert.rejects(
      acquireProfileLease(profile),
      (error: unknown) =>
        error instanceof ExpressError && error.code === "PROFILE_IN_USE",
    );
  } finally {
    await first.release();
  }

  const second = await acquireProfileLease(profile);
  try {
    if (process.platform !== "win32") {
      assert.equal((await stat(profile)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(profile, PROFILE_MARKER_FILENAME))).mode &
          0o777,
        0o600,
      );
    }
  } finally {
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("non-empty unmarked and known browser profile paths are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "express-profile-unsafe-"));
  const nonEmpty = path.join(root, "non-empty");
  await mkdir(nonEmpty);
  await writeFile(path.join(nonEmpty, "foreign-file"), "synthetic");
  await assert.rejects(
    acquireProfileLease(nonEmpty),
    (error: unknown) =>
      error instanceof ExpressError && error.code === "PROFILE_UNSAFE",
  );

  const fakeHome = path.join(root, "home");
  assert.equal(
    isKnownBrowserProfilePath(
      path.join(
        fakeHome,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "Default",
      ),
      "darwin",
      {},
      fakeHome,
    ),
    true,
  );
  await rm(root, { recursive: true, force: true });
});
