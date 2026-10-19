import * as t from './schema.js';

/**
 * Shared row types inferred from the Drizzle schema.
 *
 * They live here — next to the schema — rather than inside a module's
 * `repository.ts`, so cross-cutting consumers (ci, eval, performance,
 * conformance, compose, hooks, runs, reviews) can reference a row shape
 * WITHOUT importing another module's data layer. Each owning repository
 * re-exports its row from here to keep its public type API unchanged.
 */
export type AgentRow = typeof t.agents.$inferSelect;
export type AgentVersionRow = typeof t.agentVersions.$inferSelect;
export type FindingRow = typeof t.findings.$inferSelect;
export type PullRow = typeof t.pullRequests.$inferSelect;
export type AgentRunRow = typeof t.agentRuns.$inferSelect;
export type EvalCaseRow = typeof t.evalCases.$inferSelect;
export type EvalRunRow = typeof t.evalRuns.$inferSelect;

// Multi-user server mode (migration 0021). Consumed by the identity / audit /
// secrets repositories only — map them to domain types at the repository boundary.
export type UserRow = typeof t.users.$inferSelect;
export type WorkspaceMemberRow = typeof t.workspaceMembers.$inferSelect;
export type SessionRow = typeof t.sessions.$inferSelect;
export type OAuthFlowRow = typeof t.oauthFlows.$inferSelect;
export type ApiTokenRow = typeof t.apiTokens.$inferSelect;
export type EncryptedSecretRow = typeof t.encryptedSecrets.$inferSelect;
export type AuditEventRow = typeof t.auditEvents.$inferSelect;
export type AuditEventInsert = typeof t.auditEvents.$inferInsert;
