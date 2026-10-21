/**
 * Re-export shim. The pure GitLab note-text transforms (quick-action
 * neutralisation, attribution footer, footer stripping) moved to
 * `modules/_shared/gitlab-note-text.ts` so the `publish` module can use them
 * without a cross-module import (plan `docs/plans/gitlab-publish-findings.md`,
 * Rec2). Kept so existing importers and `test/comment-body.test.ts` stay unchanged.
 */
export * from '../_shared/gitlab-note-text.js';
