/** gitlab.com adapter barrel (REST + GraphQL over fetch). Only the container constructs the client. */
export {
  RestGitLabClient,
  encodeProject,
  GITLAB_COMMENT_UNCONFIRMED_MESSAGE,
  GITLAB_INSUFFICIENT_SCOPE_MESSAGE,
  type RestGitLabClientOptions,
} from './client.js';
export {
  GitLabHttp,
  GitLabHttpError,
  GITLAB_ORIGIN,
  classifyAuthFailure,
  type GitLabAuthFailure,
  parseRetryAfter,
  type FetchLike,
  type GitLabHttpOptions,
} from './http.js';
export * from './mappers.js';
export * from './discussions.js';
export { GITLAB_PAGE_SIZE } from './graphql.js';
