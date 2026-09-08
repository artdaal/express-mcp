import { SessionError } from "./session/types.js";

const SESSION_MESSAGES = {
  CONFIG_MISSING: "Configure this deployment first: express-mcp configure < /absolute/private/deployment.json",
  CONFIG_INVALID: "Deployment configuration is invalid; provide exact HTTPS origins and supported client metadata.",
  CONFIG_UNSAFE: "Deployment configuration must be an owned regular file with mode 0600 and valid JSON.",
  ATTACHMENT_ACCESS_DENIED: "File service denied this attachment after one bounded read retry. The session was not reset. Retry download later; do not resend the message or restart QR login solely for this file error.",
  ATTACHMENT_INVALID: "Attachment must be a regular owned file of 1 byte to 10 MiB. Image mode supports PNG only; filename and dimensions are bounded.",
  ATTACHMENT_CHANGED: "File bytes or metadata changed. Prepare the exact attachment again before sending.",
  ATTACHMENT_INTEGRITY_FAILED: "The downloaded attachment failed cryptographic integrity verification.",
  ATTACHMENT_WRITE_FAILED: "The verified attachment could not be saved to the private downloads directory.",
  ATTACHMENT_NOT_FOUND: "This exact message has no supported attachment accessible to this account.",
  UPSTREAM_ORIGIN_DENIED: "The attachment address is outside the authenticated file service.",
  UPSTREAM_RESPONSE_TOO_LARGE: "The response exceeded the supported size bound.",
  SELF_CHAT_REQUIRED: "Self-only send requires exactly one current group member: this authenticated account.",
  UPSTREAM_HTTP_500: "Express returned HTTP 500. Inspect status for the failed protocol phase; do not repeat enrollment blindly.",
  UPSTREAM_HTTP_400: "Express rejected the request format with HTTP 400.",
  UPSTREAM_HTTP_429: "Express rate limited this operation.",
  UPSTREAM_HTTP_502: "The Express gateway returned HTTP 502.",
  UPSTREAM_HTTP_503: "Express is temporarily unavailable (HTTP 503).",
  UPSTREAM_HTTP_504: "The Express gateway timed out (HTTP 504).",
  UPSTREAM_DNS_ERROR: "The configured Express server name could not be resolved.",
  UPSTREAM_TLS_ERROR: "The configured Express TLS certificate could not be verified.",
  QR_CTS_ORIGIN_DENIED: "The mobile pairing server address is outside the configured deployment. Configure its exact authorized HTTPS origin before enrolling.",
  BROKER_UNAVAILABLE: "The local session service is unavailable. Run express-mcp install, then express-mcp status.",
  BROKER_BUSY: "The local session service reached its request limit.",
  REAUTH_REQUIRED: "Run express-mcp login and approve this device in the official Express app.",
  KEYCHAIN_LOCKED: "The session Keychain item is unavailable. Unlock the macOS login Keychain and restart the service.",
  KEYCHAIN_UNAVAILABLE: "The session Keychain helper is unavailable.",
  AUTH_RECOVERY_REQUIRED: "A refresh exchange has an uncertain outcome. Run express-mcp login; the old refresh token will not be replayed.",
  AUTH_RETRY_WAIT: "Authentication refresh is waiting for a bounded retry.",
  UPSTREAM_UNAVAILABLE: "The Express server could not be reached with verified TLS.",
  UPSTREAM_UNAUTHORIZED: "The Express server rejected the current authorization.",
  UPSTREAM_TIMEOUT: "The Express operation timed out. Writes are never automatically replayed.",
  UPSTREAM_REJECTED: "The Express server rejected this operation.",
  UNSUPPORTED_PROTOCOL: "The server response does not match the supported Express protocol.",
  CRYPTO_KEY_MISSING: "A required verified encryption key is unavailable.",
  CRYPTO_KEY_MISMATCH: "The message uses an encryption key unavailable to this device.",
  CRYPTO_DECRYPT_FAILED: "The message could not be authenticated and decrypted.",
  CRYPTO_SIGNATURE_INVALID: "The message signature could not be verified.",
  QR_KEYS_MISSING: "Enrollment did not provide the existing account keys. The session was not installed.",
  LOGIN_BUSY: "Another enrollment is already active.",
} as const;

export type ErrorCode = keyof typeof SESSION_MESSAGES
  | "INVALID_INPUT"
  | "INVALID_CURSOR"
  | "PROFILE_UNSAFE"
  | "PROFILE_IN_USE"
  | "PROFILE_PERMISSION_WARNING"
  | "CHROME_NOT_FOUND"
  | "SIGNED_OUT"
  | "OFFICIAL_ORIGIN_REQUIRED"
  | "UNSUPPORTED_WEB_CLIENT"
  | "CHAT_NOT_TARGETABLE"
  | "CONFIRMATION_UNKNOWN"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_MISMATCH"
  | "SEND_OUTCOME_UNKNOWN"
  | "BROWSER_OPERATION_FAILED"
  | "LOGIN_CANCELLED"
  | "LOGIN_TIMEOUT"
  | "INTERNAL_ERROR";

const SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  ...SESSION_MESSAGES,
  INVALID_INPUT: "The request does not match the tool schema or safety bounds.",
  INVALID_CURSOR: "The cursor is unknown or does not belong to this operation.",
  PROFILE_UNSAFE:
    "The selected profile directory is not a safe, dedicated express-mcp profile.",
  PROFILE_IN_USE:
    "The selected profile is already owned by another express-mcp process.",
  PROFILE_PERMISSION_WARNING:
    "Owner-only profile permissions could not be fully enforced.",
  CHROME_NOT_FOUND:
    "A supported Google Chrome or Chromium executable was not found.",
  SIGNED_OUT:
    "The dedicated profile is signed out. Run the headed login command.",
  OFFICIAL_ORIGIN_REQUIRED:
    "Express operations require the page to be on the configured web origin.",
  UNSUPPORTED_WEB_CLIENT:
    "The configured web client does not match selector bundle express-web-3.66. Run status and inspect the headed client before retrying.",
  CHAT_NOT_TARGETABLE:
    "The opaque chat reference is unavailable. List chats again and retry.",
  CONFIRMATION_UNKNOWN:
    "The confirmation token is unknown or has already been used.",
  CONFIRMATION_EXPIRED:
    "The confirmation token expired. Prepare the message again.",
  CONFIRMATION_MISMATCH:
    "The confirmation token is not bound to this exact chat and text.",
  SEND_OUTCOME_UNKNOWN:
    "The single-use confirmation was consumed, but delivery could not be verified. No automatic retry was attempted.",
  BROWSER_OPERATION_FAILED:
    "The browser operation failed without a confirmed send.",
  LOGIN_CANCELLED:
    "The headed login window was closed before sign-in completed.",
  LOGIN_TIMEOUT:
    "The headed login did not complete before the safe timeout.",
  INTERNAL_ERROR: "The operation failed safely.",
};

export class ExpressError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "ExpressError";
    this.code = code;
  }
}

export function asExpressError(value: unknown): ExpressError {
  if (value instanceof ExpressError) return value;
  if (value instanceof SessionError && Object.hasOwn(SESSION_MESSAGES, value.code)) return new ExpressError(value.code as keyof typeof SESSION_MESSAGES);
  return new ExpressError("INTERNAL_ERROR");
}

export function safeErrorBody(error: unknown): {
  ok: false;
  error: { code: ErrorCode; message: string };
} {
  const safe = asExpressError(error);
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
    },
  };
}
