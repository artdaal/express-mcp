import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { ExpressError, safeErrorBody } from "../src/errors.js";
import { createSafeLogger } from "../src/logger.js";

test("default logs and structured errors cannot include untrusted sentinels", () => {
  const sentinels = [
    "SENTINEL_COOKIE",
    "SENTINEL_BEARER",
    "SENTINEL_REFRESH_TOKEN",
    "SENTINEL_CHAT_ID",
    "SENTINEL_CHAT_TITLE",
    "SENTINEL_PARTICIPANT",
    "SENTINEL_CONFIRMATION",
    "SENTINEL_MESSAGE_BODY",
    "SENTINEL_SEARCH_QUERY",
    "SENTINEL_DIRECT_DETAIL",
    "SENTINEL_FINGERPRINT",
    "SENTINEL_RAW_BROWSER_ERROR",
  ];
  let captured = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk);
      callback();
    },
  });
  const logger = createSafeLogger(destination);
  logger.info({
    operation: "synthetic_operation",
    code: "SAFE_CODE",
    count: 1,
    durationMs: 2,
  });
  const error = safeErrorBody(new ExpressError("INTERNAL_ERROR"));
  const combined = `${captured}${JSON.stringify(error)}`;
  for (const sentinel of sentinels) {
    assert.equal(combined.includes(sentinel), false);
  }
});
