import { describe, it, expect } from 'vitest';
import {
  groundConventions,
  type RawConventionCandidate,
} from '../src/modules/conventions/grounding.js';

/**
 * Pure tests for the conventions grounding gate: keep-or-drop-with-reason,
 * 1-based inclusive line resolution, whitespace-tolerant fallback. Mirrors the
 * discipline of reviewer-core's grounding gate on the server side.
 */

const FILE = [
  'import { db } from "./db";', // 1
  '', // 2
  'export async function getUser(id: string) {', // 3
  '  const user = await db.users.find(id);', // 4
  '  const posts = await db.posts.findMany({ userId: id });', // 5
  '  return { user, posts };', // 6
  '}', // 7
].join('\n');

function candidate(overrides: Partial<RawConventionCandidate> = {}): RawConventionCandidate {
  return {
    category: 'error-handling',
    rule: 'Always use async/await instead of .then() chains',
    evidence_path: 'src/api/users.ts',
    evidence_snippet: '  const user = await db.users.find(id);',
    confidence: 0.9,
    ...overrides,
  };
}

const files = new Map([['src/api/users.ts', FILE]]);

describe('groundConventions', () => {
  it('keeps an exact-match snippet and resolves 1-based inclusive lines', () => {
    const snippet = '  const user = await db.users.find(id);\n  const posts = await db.posts.findMany({ userId: id });';
    const result = groundConventions([candidate({ evidence_snippet: snippet })], files);
    expect(result.dropped).toHaveLength(0);
    expect(result.kept[0]).toMatchObject({ evidence_start_line: 4, evidence_end_line: 5 });
    expect(result.summary).toBe('1/1 candidates passed grounding');
  });

  it('falls back to whitespace-tolerant matching when indentation differs', () => {
    const snippet = 'const user = await db.users.find(id);\nconst posts = await db.posts.findMany({ userId: id });';
    const result = groundConventions([candidate({ evidence_snippet: snippet })], files);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toMatchObject({ evidence_start_line: 4, evidence_end_line: 5 });
  });

  it('ignores leading/trailing blank snippet lines', () => {
    const result = groundConventions(
      [candidate({ evidence_snippet: '\n  return { user, posts };\n' })],
      files,
    );
    expect(result.kept[0]).toMatchObject({ evidence_start_line: 6, evidence_end_line: 6 });
  });

  it('drops a candidate whose path was not sampled', () => {
    const result = groundConventions([candidate({ evidence_path: 'src/other.ts' })], files);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toBe('path-not-sampled');
  });

  it('drops a candidate whose snippet does not occur in the file', () => {
    const result = groundConventions(
      [candidate({ evidence_snippet: 'const totallyFabricated = 42;' })],
      files,
    );
    expect(result.dropped[0]!.reason).toBe('snippet-not-found');
  });

  it('drops a candidate with a whitespace-only snippet', () => {
    const result = groundConventions([candidate({ evidence_snippet: '   \n  ' })], files);
    expect(result.dropped[0]!.reason).toBe('empty-snippet');
  });

  it('summary counts kept over total', () => {
    const result = groundConventions(
      [candidate(), candidate({ evidence_path: 'nope.ts' }), candidate({ evidence_snippet: 'zzz' })],
      files,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
    expect(result.summary).toBe('1/3 candidates passed grounding');
  });
});
