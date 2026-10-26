/**
 * Publish marker (spec `specs/2026-10-21-gitlab-publish-findings.md`, AC-24,
 * AC-43; plan "Marker technique — decision" test strategy).
 */
import { describe, it, expect } from 'vitest';
import {
  MARKER_LINE_LENGTH,
  buildMarker,
  parseMarker,
  stripMarker,
} from '../src/modules/_shared/publish-marker.js';
import { footerFor, neutraliseQuickActions } from '../src/modules/_shared/gitlab-note-text.js';
import { guardFindingText } from '../src/modules/publish/mention-guard.js';

const W = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const F = 'abcdef01-3333-4333-8333-33333333abcd';
const ids = { workspaceId: W, publicationId: P, findingId: F };

/** GitLab's documented note normalisation: strip `\r`, trim trailing whitespace. */
function gitlabNormalise(body: string): string {
  return body
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

describe('publish marker', () => {
  it('builds the exact ids-only line with a fixed length', () => {
    const m = buildMarker(ids);
    expect(m).toBe(`<!-- devdigest:publish:v1 w=${W} p=${P} f=${F} -->`);
    expect(m.length).toBe(MARKER_LINE_LENGTH);
    expect(m).not.toMatch(/[\n@#~%&$]|![^-]/);
    expect(buildMarker({ ...ids, findingId: F.toUpperCase() })).toBe(m); // ids are lowercased
    expect(() => buildMarker({ ...ids, findingId: 'not-a-uuid' })).toThrow();
  });

  it('round-trips build → parse → strip, also after GitLab normalisation', () => {
    const body = `**WARNING** · bug · Title\n\nRationale\n\n${buildMarker(ids)}${footerFor('Jane')}`;
    expect(parseMarker(body)).toEqual(ids);
    expect(parseMarker(gitlabNormalise(body.replace(/\n/g, '\r\n') + '  \n'))).toEqual(ids);
    const local = `Body\n\n${buildMarker(ids)}`;
    expect(stripMarker(local)).toBe('Body');
    expect(parseMarker(stripMarker(local))).toBeNull();
  });

  it('survives quick-action neutralisation and the mention guard unchanged', () => {
    const m = buildMarker(ids);
    expect(neutraliseQuickActions(`/merge\n\n${m}`).endsWith(`\n${m}`)).toBe(true);
    expect(guardFindingText(m)).toBe(m);
  });

  it('parses the LAST marker; another workspace is returned with its own ids', () => {
    const other = { ...ids, workspaceId: '44444444-4444-4444-8444-444444444444' };
    const body = `${buildMarker(ids)}\n\ntext\n\n${buildMarker(other)}`;
    expect(parseMarker(body)).toEqual(other);
  });

  it('rejects malformed, uppercase, inline and trailing-text variants', () => {
    const m = buildMarker(ids);
    expect(parseMarker(m.replace(F, 'zzzzzzzz-3333-4333-8333-333333333333'))).toBeNull();
    expect(parseMarker(m.replace(F, F.toUpperCase()))).toBeNull();
    expect(parseMarker(m.replace('v1', 'V1'))).toBeNull();
    expect(parseMarker(`text ${m}`)).toBeNull();
    expect(parseMarker(`${m} more`)).toBeNull();
    expect(parseMarker(`${m}x`)).toBeNull();
    expect(parseMarker(m.replace(F, F.slice(0, -1)))).toBeNull();
  });

  it('strips only the marker line and the blank line before it', () => {
    const m = buildMarker(ids);
    expect(stripMarker(`A\n\n\nB\n\n${m}`)).toBe('A\n\n\nB');
    expect(stripMarker(`A\n${m}\nC`)).toBe('A\nC');
    expect(stripMarker('no marker\n\n')).toBe('no marker\n\n');
    expect(stripMarker(`A\n\n${m} trailing`)).toBe(`A\n\n${m} trailing`);
  });
});
