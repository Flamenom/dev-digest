import { describe, it, expect } from 'vitest';
import { resolveSpecPaths } from '../src/modules/project-context/injection.js';

/**
 * Pure-function tests for the spec-path union resolver (AC-19/AC-21):
 * agent paths first (persisted order), then each loaded skill's paths in
 * skill-load order, deduped by exact path keeping the FIRST occurrence.
 */

describe('resolveSpecPaths', () => {
  it('unions agent [a,b] + skill1 [b,c] + skill2 [a,d] → [a,b,c,d] (AC-19/AC-21)', () => {
    expect(
      resolveSpecPaths({
        agentPaths: ['a', 'b'],
        loadedSkills: [{ paths: ['b', 'c'] }, { paths: ['a', 'd'] }],
      }),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('empty inputs → []', () => {
    expect(resolveSpecPaths({ agentPaths: [], loadedSkills: [] })).toEqual([]);
    expect(resolveSpecPaths({ agentPaths: [], loadedSkills: [{ paths: [] }] })).toEqual([]);
  });

  it('agent order is preserved and wins over skill order', () => {
    expect(
      resolveSpecPaths({
        agentPaths: ['z', 'a'],
        loadedSkills: [{ paths: ['a', 'z', 'm'] }],
      }),
    ).toEqual(['z', 'a', 'm']);
  });

  it('skills contribute in load order, each in its persisted order', () => {
    expect(
      resolveSpecPaths({
        agentPaths: [],
        loadedSkills: [{ paths: ['s2', 's1'] }, { paths: ['s3', 's1'] }],
      }),
    ).toEqual(['s2', 's1', 's3']);
  });

  it('dedupe is by exact path string (no normalization)', () => {
    expect(
      resolveSpecPaths({
        agentPaths: ['docs/a.md'],
        loadedSkills: [{ paths: ['docs/./a.md', 'docs/a.md'] }],
      }),
    ).toEqual(['docs/a.md', 'docs/./a.md']);
  });
});
