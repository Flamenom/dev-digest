import type { Convention } from '@devdigest/shared';
import type { ConventionRow } from './repository.js';

/** DB row → API DTO (snake_case per the shared contracts). */
export function toConventionDto(row: ConventionRow): Convention {
  return {
    id: row.id,
    repo_id: row.repoId ?? '',
    category: row.category,
    rule: row.rule,
    evidence_path: row.evidencePath ?? '',
    evidence_snippet: row.evidenceSnippet ?? '',
    evidence_start_line: row.evidenceStartLine,
    evidence_end_line: row.evidenceEndLine,
    confidence: row.confidence ?? 0,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}
