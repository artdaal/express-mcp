#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "express-mcp-package-"));
const installDir = path.join(root, "install");

try {
  const packed = await execute(
    "npm",
    ["pack", "--json", "--pack-destination", root],
    {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const manifest = JSON.parse(packed.stdout);
  const filename = manifest[0]?.filename;
  const names = manifest[0]?.files?.map(file => file.path) ?? [];
  if (names.some(name => name.startsWith(".agent/") || name.startsWith("dist/test/") || name.startsWith("native/bin/"))) throw new Error("Local workflow, tests or host binaries leaked into the package.");
  for (const required of ["native/keychain.swift", "native/session-lock.swift", "scripts/install.mjs", "scripts/build-native.mjs", "dist/src/session/broker.js", "docs/diagrams/architecture.png", "docs/diagrams/authentication.png"]) if (!names.includes(required)) throw new Error(`Missing package component: ${required}`);
  if (typeof filename !== "string") {
    throw new Error("Package smoke did not receive an npm tarball name.");
  }
  await execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDir,
      path.join(root, filename),
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const executable =
    process.platform === "win32"
      ? path.join(installDir, "node_modules", ".bin", "express-mcp.cmd")
      : path.join(installDir, "node_modules", ".bin", "express-mcp");
  await access(executable);
  const help = await execute(executable, ["--help"], {
    cwd: installDir,
    maxBuffer: 1024 * 1024,
  });
  if (!help.stdout.includes("express-mcp serve")) {
    throw new Error("Installed package bin did not return expected help.");
  }
  if (!help.stdout.includes("express-mcp live-search-smoke --query")) {
    throw new Error(
      "Installed package bin did not expose live-search-smoke help.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      packed: true,
      installedBin: "express-mcp",
      executable: true,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
