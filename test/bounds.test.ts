import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedPage,
  serializedResultBytes,
} from "../src/bounds.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_SERIALIZED_RESULT_BYTES,
} from "../src/constants.js";
import { CursorStore } from "../src/cursors.js";
import { ExpressError } from "../src/errors.js";

test("pagination defaults, maximums, opaque scope binding, and ordering", () => {
  let token = 0;
  const cursors = new CursorStore(() => `cursor-${token++}`);
  const items = Array.from({ length: 75 }, (_, index) => ({
    messageId: `message-${index}`,
    text: `Synthetic ${index}`,
  }));
  const first = boundedPage(items, {}, "read:a", cursors);
  assert.equal(first.count, DEFAULT_PAGE_LIMIT);
  assert.equal(first.items[0]?.messageId, "message-0");
  assert.ok(first.nextCursor);
  const nextCursor = first.nextCursor;
  const second = boundedPage(
    items,
    { cursor: nextCursor, limit: 50 },
    "read:a",
    cursors,
  );
  assert.equal(second.count, 50);
  assert.equal(second.items[0]?.messageId, "message-20");
  assert.throws(
    () =>
      boundedPage(
        items,
        { cursor: nextCursor },
        "read:other",
        cursors,
      ),
    (error: unknown) =>
      error instanceof ExpressError && error.code === "INVALID_CURSOR",
  );
  assert.throws(
    () => boundedPage(items, { limit: 51 }, "read:a", cursors),
    (error: unknown) =>
      error instanceof ExpressError && error.code === "INVALID_INPUT",
  );
});

test("serialized pages stay capped and signal shortening or pagination", () => {
  let token = 0;
  const cursors = new CursorStore(() => `cap-cursor-${token++}`);
  const items = Array.from({ length: 50 }, (_, index) => ({
    messageId: `large-${index}`,
    text: "x".repeat(100_000),
    timestamp: "12:00",
  }));
  const page = boundedPage(items, { limit: 50 }, "read:large", cursors);
  assert.ok(
    serializedResultBytes(page) <= MAX_SERIALIZED_RESULT_BYTES,
  );
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor);
  assert.ok(page.items.length >= 1);
  assert.ok(page.items.length < 50);
});
