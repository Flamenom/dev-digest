/* read-only-host — "copy instead of post" helpers shared by the PR page: the
   copy-to-clipboard hook used by the FindingCard's "Copy finding" and the
   inline composer's "Copy text" after a failed post. (The former disabled
   post control + read-only note are gone — GitLab posts now.) */
export { useCopyToClipboard } from "./useCopyToClipboard";
