import { cp, mkdir, readFile, writeFile, lstat, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
process.umask(0o077);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--workspace" || !path.isAbsolute(args[1])) throw new Error("Usage: node scripts/install-skill.mjs --workspace /absolute/agent/workspace");
const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = args[1]; const info = await lstat(workspace);
if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("Workspace must be an existing owned directory, not a symlink.");
const skills = path.join(workspace, "skills"); await mkdir(skills, {recursive: true});
const skillInfo = await lstat(skills); if (!skillInfo.isDirectory() || skillInfo.isSymbolicLink() || skillInfo.uid !== process.getuid()) throw new Error("Unsafe skill directory.");
const target = path.join(skills, "express-messenger");
try { await lstat(target); throw new Error("Skill already exists; review and back it up before replacing it."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const stage = path.join(skills, `.express-${randomUUID()}`);
try {
  await cp(path.join(root, "skills/express-messenger"), stage, {recursive: true, errorOnExist: true, force: false});
  await writeFile(path.join(stage, "installation.json"), JSON.stringify({node: process.execPath, entry: path.join(root, "dist/src/cli.js")}), {mode: 0o600});
  await rename(stage, target);
} finally { await rm(stage, {recursive: true, force: true}); }
process.stdout.write(JSON.stringify({ok: true, skillPath: target, registeredMcpTools: 0, newAgentSessionRecommended: true}) + "\n");
