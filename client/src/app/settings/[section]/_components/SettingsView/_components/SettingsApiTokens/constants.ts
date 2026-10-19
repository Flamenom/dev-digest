/* Personal API token limits — mirrored from the `ApiTokenCreateInput` contract
   (the client may import only TYPES from the vendored shared package). */
export const TOKEN_NAME_MAX = 64;
export const TOKEN_EXPIRY_MIN_DAYS = 1;
export const TOKEN_EXPIRY_MAX_DAYS = 365;
export const TOKEN_EXPIRY_DEFAULT_DAYS = 90;

/** How long the "Copied" confirmation stays on the copy button. */
export const COPIED_RESET_MS = 2000;

/** Token-table column header keys (i18n, `settings` namespace). */
export const TOKEN_COLUMNS = [
  "apiTokens.colName",
  "apiTokens.colPrefix",
  "apiTokens.colCreated",
  "apiTokens.colLastUsed",
  "apiTokens.colExpires",
  "apiTokens.colActions",
] as const;
