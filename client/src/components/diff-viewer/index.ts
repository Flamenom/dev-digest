/* diff-viewer — unified-diff viewer with optional inline host comments
   (GitHub review comments / GitLab diff notes).
   Public surface: the DiffViewer component + the DiffCommentApi contract, plus
   FileCard + LineFinding for callers composing their own file list (Smart Diff). */
export { DiffViewer } from "./DiffViewer";
export { FileCard } from "./FileCard";
export type { DiffCommentApi, CommentSubmitInput } from "./comments";
export type { LineFinding } from "./constants";
