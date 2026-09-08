import type { Writable } from "node:stream";

export interface SafeLogFields {
  operation: string;
  code?: string;
  count?: number;
  durationMs?: number;
  selectorVersion?: string;
}

export interface SafeLogger {
  info(fields: SafeLogFields): void;
  warn(fields: SafeLogFields): void;
  error(fields: SafeLogFields): void;
}

const ALLOWED_KEYS = new Set([
  "operation",
  "code",
  "count",
  "durationMs",
  "selectorVersion",
]);

export function createSafeLogger(
  destination: Writable = process.stderr,
): SafeLogger {
  const write = (level: "info" | "warn" | "error", fields: SafeLogFields) => {
    const safeFields = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => ALLOWED_KEYS.has(key) && value !== undefined,
      ),
    );
    destination.write(`${JSON.stringify({ level, ...safeFields })}\n`);
  };

  return {
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
  };
}
