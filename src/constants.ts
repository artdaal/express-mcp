// Legacy DOM adapter only; the session broker uses its private deployment config.
export const EXPRESS_ORIGIN = process.env.EXPRESS_WEB_ORIGIN ?? "https://chat.example.com";
export const EXPRESS_ENTRY_URL = `${EXPRESS_ORIGIN}/#/`;
export const SELECTOR_BUNDLE_VERSION = "express-web-3.66";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;
export const MAX_SERIALIZED_RESULT_BYTES = 240 * 1024;
export const MAX_CHAT_ID_LENGTH = 512;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_CONFIRMATION_TOKEN_LENGTH = 512;
export const MAX_MESSAGE_TEXT_LENGTH = 65_536;
export const MAX_SEARCH_QUERY_CODE_POINTS = 256;
export const MAX_SEARCH_QUERY_BYTES = 1_024;
export const CONFIRMATION_TTL_MS = 120_000;
export const SEARCH_SETTLE_MS = 1_000;
export const SEARCH_SETTLE_STABILITY_MS = 250;
export const SEARCH_SETTLE_POLL_MS = 100;
export const SEARCH_UI_TIMEOUT_MS = 10_000;

export const PROFILE_MARKER_FILENAME = ".express-mcp-profile.json";
export const PROFILE_LOCK_FILENAME = ".express-mcp.lock";
