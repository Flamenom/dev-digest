/* constants.ts — EvalCaseEditorModal.
   Named values only; no magic numbers or strings in the component body. */

/** The two `Input` tabs. There is deliberately NO `Files` tab (spec §19.1):
    `reviewPullRequest` accepts a `UnifiedDiff` and nothing else file-shaped, so
    a Files editor would let the user author content the engine cannot read. The
    shipped i18n agrees — `caseEditor.tabs` has only `{ diff, prMeta }`. */
export const INPUT_TABS = ["diff", "prMeta"] as const;
export type InputTab = (typeof INPUT_TABS)[number];

/** `+ Finding skeleton` fallback path, used only when the diff names no file. */
export const SKELETON_FILE = "path/to/file.ts";

/** `JSON.stringify` indent for the `Expected output` editor. */
export const JSON_INDENT = 2;

/** Rows for the two long-form editors. */
export const DIFF_ROWS = 10;
export const EXPECTED_ROWS = 10;
export const BODY_ROWS = 5;

/** Modal width — wide enough for a unified diff without horizontal scrolling. */
export const MODAL_WIDTH = 1040;

/** The server answers 409 `case_has_runs` with the affected run count (AC-12).
    If the payload omits it we still know at least one run exists, so the
    confirmation stays truthful rather than claiming "0 recorded runs". */
export const FALLBACK_RUN_COUNT = 1;
