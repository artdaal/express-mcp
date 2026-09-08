import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_SERIALIZED_RESULT_BYTES,
} from "./constants.js";
import { CursorStore } from "./cursors.js";
import { ExpressError } from "./errors.js";

export interface PageInput {
  cursor?: string;
  limit?: number;
}

export interface PageResult<T> {
  ok: true;
  items: T[];
  count: number;
  limit: number;
  truncated: boolean;
  nextCursor?: string;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function compactStrings<T>(item: T, maximumStringBytes: number): {
  item: T;
  changed: boolean;
} {
  let changed = false;
  const compacted = Object.fromEntries(
    Object.entries(item as Record<string, unknown>).map(([key, value]) => {
      if (
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") > maximumStringBytes
      ) {
        changed = true;
        return [key, truncateUtf8(value, maximumStringBytes)];
      }
      return [key, value];
    }),
  ) as T;
  return { item: compacted, changed };
}

export function normalizeLimit(limit: number | undefined): number {
  const selected = limit ?? DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_PAGE_LIMIT
  ) {
    throw new ExpressError("INVALID_INPUT");
  }
  return selected;
}

export function boundedPage<T>(
  allItems: readonly T[],
  input: PageInput,
  scope: string,
  cursorStore: CursorStore,
): PageResult<T> {
  const limit = normalizeLimit(input.limit);
  const offset = cursorStore.resolve(input.cursor, scope);
  if (offset < 0 || offset > allItems.length) {
    throw new ExpressError("INVALID_CURSOR");
  }

  const candidates = allItems.slice(offset, offset + limit);
  const outputItems: T[] = [];
  let truncated = false;

  for (const source of candidates) {
    const compacted = compactStrings(source, 48 * 1024);
    truncated ||= compacted.changed;
    const candidate = compacted.item;

    const proposed = {
      ok: true as const,
      items: [...outputItems, candidate],
      count: outputItems.length + 1,
      limit,
      truncated,
      nextCursor: "x".repeat(64),
    };
    if (serializedBytes(proposed) > MAX_SERIALIZED_RESULT_BYTES) {
      if (outputItems.length > 0) {
        truncated = true;
        break;
      }
      throw new ExpressError("INTERNAL_ERROR");
    }
    outputItems.push(candidate);
  }

  const nextOffset = offset + outputItems.length;
  const result: PageResult<T> = {
    ok: true,
    items: outputItems,
    count: outputItems.length,
    limit,
    truncated,
    ...(nextOffset < allItems.length
      ? { nextCursor: cursorStore.issue(scope, nextOffset) }
      : {}),
  };

  if (serializedBytes(result) > MAX_SERIALIZED_RESULT_BYTES) {
    throw new ExpressError("INTERNAL_ERROR");
  }
  return result;
}

export function serializedResultBytes(value: unknown): number {
  return serializedBytes(value);
}
