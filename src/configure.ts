import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, privateDirectory } from "./session/paths.js";
import { configSchema, SessionError } from "./session/types.js";
import { readInput } from "./agent.js";

export async function configure() {
  let value;
  try { value = configSchema.parse(await readInput(4096)); }
  catch { throw new SessionError("CONFIG_INVALID"); }
  const base = dataDir(); await privateDirectory(base);
  const tmp = join(base, `.config-${randomUUID()}`);
  try { await writeFile(tmp, JSON.stringify(value) + "\n", {mode: 0o600, flag: "wx"}); await rename(tmp, join(base, "session.json")); }
  finally { await rm(tmp, {force: true}); }
  process.stdout.write(JSON.stringify({ok: true, configured: true, restartRequired: true}) + "\n");
}
