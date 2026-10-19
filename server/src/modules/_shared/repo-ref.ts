/**
 * Thin re-export: the pure repo-identity primitives live in the core ring
 * (`@devdigest/shared` → `repo-identity.ts`) so adapters can use them without
 * importing the modules tree. Kept so module importers stay unchanged.
 */
export {
  PROVIDER_HOST,
  hostRepoRef,
  repoWebUrl,
  cloneRemoteUrl,
  type RepoIdentityRow,
} from '@devdigest/shared';
