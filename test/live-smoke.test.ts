import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  liveSearchSmokeAggregate,
  liveSmokeBounds,
} from "../src/live-smoke.js";

const execute = promisify(execFile);

test("live smoke aggregate uses the selected list limit truthfully", () => {
  assert.deepEqual(liveSmokeBounds(7, 7, 1, 1), {
    listCount: 7,
    readCount: 1,
    listBounded: true,
    readBounded: true,
  });
  assert.equal(liveSmokeBounds(8, 7, 1, 1).listBounded, false);
});

test("live search smoke output is aggregate-only", () => {
  const aggregate = liveSearchSmokeAggregate({
    selectorVersion: "express-web-3.66",
    requestedLimit: 20,
    returnedResultCount: 3,
    truncated: false,
    allResultsDirect: true,
    searchStateCleared: true,
  });
  assert.deepEqual(aggregate, {
    ok: true,
    selectorVersion: "express-web-3.66",
    requestedLimit: 20,
    returnedResultCount: 3,
    resultCountBounded: true,
    truncationReported: true,
    allResultsDirect: true,
    searchStateCleared: true,
  });
  const serialized = JSON.stringify(aggregate);
  for (const forbidden of [
    "SENTINEL_QUERY",
    "SENTINEL_NAME",
    "SENTINEL_DETAIL",
    "SENTINEL_CHAT_ID",
    "SENTINEL_MESSAGE",
    "SENTINEL_PROFILE",
    "SENTINEL_AUTH",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("live search smoke source cannot read, prepare, send, or click a result", async () => {
  const source = await readFile(
    path.resolve("src/cli.ts"),
    "utf8",
  );
  const liveSearchBody = source.slice(
    source.indexOf("async function runLiveSearchSmoke"),
    source.indexOf("async function main"),
  );
  assert.ok(liveSearchBody.includes("service.searchDirectChats"));
  assert.ok(liveSearchBody.includes("adapter.listChats"));
  assert.equal(liveSearchBody.includes(".readChat("), false);
  assert.equal(liveSearchBody.includes(".prepareMessage("), false);
  assert.equal(liveSearchBody.includes(".sendMessage("), false);
  assert.equal(liveSearchBody.includes(".click("), false);
  assert.equal(liveSearchBody.includes("screenshot"), false);
  assert.equal(liveSearchBody.includes("trace"), false);
  assert.equal(liveSearchBody.includes("HAR"), false);
});

test("mock cannot opt into live search and CLI errors do not echo its query", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "express-search-cli-"));
  const query = "SENTINEL_LIVE_SEARCH_QUERY";
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [
          path.resolve("dist/src/cli.js"),
          "live-search-smoke",
          "--query",
          query,
          "--profile-dir",
          path.join(root, "profile"),
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            EXPRESS_MCP_ADAPTER: "mock",
          },
        },
      ),
      (error: unknown) => {
        const result = error as { stdout?: string; stderr?: string };
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        return !output.includes(query);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
