import { ADD_REPO_ERROR_CODES, type AddRepoErrorCode } from "./constants";

/** Narrow an API error code to one with a localized Add-repo message. */
export function addRepoErrorCode(code: string | undefined): AddRepoErrorCode | null {
  return (ADD_REPO_ERROR_CODES as readonly string[]).includes(code ?? "")
    ? (code as AddRepoErrorCode)
    : null;
}
