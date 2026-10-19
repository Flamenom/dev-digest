import type { HostErrorCode } from "@/lib/types";

/** Server error codes from POST /repos that get a localized inline message
 *  (`repos.add.errors.<code>`). Any other failure shows the server message. */
export const ADD_REPO_ERROR_CODES = [
  "unsupported_repo_host",
  "gitlab_token_missing",
  "gitlab_token_invalid",
  "gitlab_project_inaccessible",
] as const satisfies readonly HostErrorCode[];

export type AddRepoErrorCode = (typeof ADD_REPO_ERROR_CODES)[number];
