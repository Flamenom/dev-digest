import type { Role } from "@devdigest/shared";

/** Role selector options, in display order. Labels come from `auth.roles.*`. */
export const ROLES: readonly Role[] = ["admin", "member"];

/** Members-table column header keys (i18n, `settings` namespace). */
export const MEMBER_COLUMNS = [
  "members.colMember",
  "members.colRole",
  "members.colStatus",
  "members.colJoined",
  "members.colLastSignIn",
] as const;

/** Extra Admin-only column for the role/status actions. */
export const MEMBER_ACTIONS_COLUMN = "members.colActions";
