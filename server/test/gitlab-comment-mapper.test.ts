/**
 * toHostComment — GitLab diff note → host-neutral read shape (spec AC-2 – AC-5, AC-7).
 */
import { describe, it, expect } from 'vitest';
import type { GitLabDiffNote } from '@devdigest/shared';
import { HostComment } from '@devdigest/shared';
import { toHostComment } from '../src/modules/pulls/gitlab-comment-mapper.js';
import { composeGitLabText } from '../src/modules/pulls/comment-body.js';

const HEAD = 'head-sha-1';
const ctx = {
  currentHeadSha: HEAD,
  webUrl: 'https://gitlab.com/group/sub/project',
  iid: 42,
  serviceAccount: 'devdigest-bot',
};

function note(over: Partial<GitLabDiffNote> = {}, pos: Partial<GitLabDiffNote['position']> = {}): GitLabDiffNote {
  return {
    id: 100,
    discussionId: 'disc-a',
    rootNoteId: 100,
    author: 'alice',
    body: 'Looks off',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...over,
    position: {
      headSha: HEAD,
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      oldLine: null,
      newLine: 7,
      ...pos,
    },
  };
}

describe('toHostComment', () => {
  it('maps new_line → RIGHT and old-only → LEFT (AC-3)', () => {
    const right = toHostComment(note({}, { oldLine: 6, newLine: 7 }), ctx);
    expect(right).toMatchObject({ side: 'RIGHT', line: 7, original_line: 7 });
    const left = toHostComment(note({}, { oldLine: 9, newLine: null }), ctx);
    expect(left).toMatchObject({ side: 'LEFT', line: 9, original_line: 9 });
  });

  it('marks a note anchored at another head outdated (AC-4)', () => {
    const c = toHostComment(note({}, { headSha: 'older-head' }), ctx);
    expect(c).toMatchObject({ is_outdated: true, line: null, original_line: 7 });
    expect(toHostComment(note(), ctx).is_outdated).toBe(false);
  });

  it('builds the note html_url (AC-5)', () => {
    expect(toHostComment(note({ id: 555 }), ctx).html_url).toBe(
      'https://gitlab.com/group/sub/project/-/merge_requests/42#note_555',
    );
  });

  it('groups replies under the root note (AC-2)', () => {
    const root = toHostComment(note(), ctx);
    expect(root).toMatchObject({ in_reply_to_id: null, discussion_id: 'disc-a', provider: 'gitlab', user: 'alice' });
    const reply = toHostComment(note({ id: 101 }), ctx);
    expect(reply).toMatchObject({ id: 101, in_reply_to_id: 100, discussion_id: 'disc-a' });
  });

  it('uses new_path, falling back to old_path for a removed-line note', () => {
    expect(toHostComment(note({}, { oldPath: 'old.ts', newPath: null, newLine: null, oldLine: 2 }), ctx).path).toBe('old.ts');
  });

  it('strips the footer only on service-account notes (AC-7)', () => {
    const body = composeGitLabText('Nit', 'Jane Doe');
    const mine = toHostComment(note({ author: 'devdigest-bot', body }), ctx);
    expect(mine).toMatchObject({ body: 'Nit', devdigest_attribution: { name: 'Jane Doe' } });
    const theirs = toHostComment(note({ author: 'mallory', body }), ctx);
    expect(theirs).toMatchObject({ body, devdigest_attribution: null });
  });

  it('produces a valid HostComment', () => {
    expect(HostComment.safeParse(toHostComment(note(), ctx)).success).toBe(true);
  });
});
