/** gitlab.com adapter barrel (REST + GraphQL over fetch). Only the container constructs the client. */
export { RestGitLabClient, encodeProject, type RestGitLabClientOptions } from './client.js';
export {
  GitLabHttp,
  GitLabHttpError,
  GITLAB_ORIGIN,
  parseRetryAfter,
  type FetchLike,
  type GitLabHttpOptions,
} from './http.js';
export * from './mappers.js';
export { GITLAB_PAGE_SIZE } from './graphql.js';
