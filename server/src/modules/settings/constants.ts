/** Constants for the settings module. */

/** Provider id used by the GitHub connection test branch. */
export const GITHUB_PROVIDER = 'github';

/** Provider id used by the GitLab connection test branch. */
export const GITLAB_PROVIDER = 'gitlab';

/** Re-exported from its neutral home (`platform/secret-keys.ts`) for existing callers. */
export { SECRET_KEY_BY_PROVIDER } from '../../platform/secret-keys.js';
