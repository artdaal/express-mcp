#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
let config;
try { config = JSON.parse(readFileSync(new URL("../installation.json", import.meta.url), "utf8")); }
catch { process.stderr.write('Skill not installed: run node scripts/install-skill.mjs --workspace /absolute/workspace\n'); process.exit(1); }
const child = spawn(config.node, [config.entry, "agent"], {stdio: "inherit"});
child.once("error", () => {process.stderr.write('Express runtime unavailable; reinstall the skill.\n'); process.exitCode = 1;});
child.once("exit", code => {process.exitCode = code ?? 1;});
