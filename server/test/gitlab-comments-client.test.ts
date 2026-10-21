/**
 * RestGitLabClient as `GitLabCommentsHost` (plan gitlab-comments T2):
 * diff-discussion reads (AC-1/AC-2), diff refs (AC-12), discussion lookup
 * (AC-19/AC-20), new discussion position (AC-8/9/10), replies, and error
 * mapping (AC-29–AC-31). Plus the pure discussion mappers and the mock.
 * Hermetic fake fetch.
 */
import { describe, it, expect } from 'vitest';
import type { GitLabTextPosition, HostRepoRef } from '@devdigest/shared';
import { RestGitLabClient } from '../src/adapters/gitlab/client.js';
import {
  mapDiscussions,
  toApiPosition,
  type RestDiscussion,
  type RestNote,
} from '../src/adapters/gitlab/discussions.js';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { fakeFetch, fakeSleep, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-COMMENTS-SECRET';
const FULL = 'space-profit/platform/crm-frontend';
const ENC = encodeURIComponent(FULL);
const MR = `/projects/${ENC}/merge_requests/42`;
const REF: HostRepoRef = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'space-profit/platform',
  name: 'crm-frontend',
  fullName: FULL,
};
const UNCONFIRMED = "GitLab didn't confirm the comment — check the MR before posting again.";

const rawPath = (r: FakeRequest) => r.url.href.replace('https://gitlab.com/api/v4', '').split('?')[0];

function client(handler: (req: FakeRequest) => Response | Promise<Response>) {
  const { fetch, calls } = fakeFetch(handler);
  const c = new RestGitLabClient({ token: TOKEN, fetch, sleep: fakeSleep().sleep, random: () => 0.5 });
  return { c, calls };
}

async function caught(p: Promise<unknown>): Promise<Error & { code?: string; statusCode?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; statusCode?: number };
  }
  throw new Error('expected a rejection');
}

const textPos = (extra: Record<string, unknown> = {}) => ({
  position_type: 'text',
  base_sha: 'base1',
  start_sha: 'start1',
  head_sha: 'head1',
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  old_line: null,
  new_line: 10,
  ...extra,
});

function note(id: number, extra: Partial<RestNote> = {}): RestNote {
  return {
    id,
    type: 'DiffNote',
    system: false,
    body: `note ${id}`,
    author: { username: 'alice' },
    created_at: '2026-10-20T10:00:00Z',
    position: textPos() as RestNote['position'],
    ...extra,
  };
}

/** 2 diff discussions (3 notes), 1 individual note, 2 system notes, 1 image-positioned. */
const FIXTURE: RestDiscussion[] = [
  { id: 'd1', individual_note: false, notes: [note(1), note(2, { author: { username: 'bob' } })] },
  {
    id: 'd2',
    individual_note: false,
    notes: [
      note(3, { position: textPos({ old_line: 4, new_line: null }) as RestNote['position'] }),
      note(4, { system: true, type: null, body: 'changed this line in version 2' }),
    ],
  },
  { id: 'd3', individual_note: true, notes: [note(5, { type: null, position: null })] },
  { id: 'd4', individual_note: true, notes: [note(6, { system: true, type: null, position: null })] },
  {
    id: 'd5',
    individual_note: false,
    notes: [note(7, { position: textPos({ position_type: 'image' }) as RestNote['position'] })],
  },
];

describe('mapDiscussions (pure, AC-1/AC-2)', () => {
  it('keeps only text diff discussions and drops system notes → 3 notes', () => {
    const notes = mapDiscussions(FIXTURE);
    expect(notes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(notes.map((n) => [n.discussionId, n.rootNoteId])).toEqual([
      ['d1', 1],
      ['d1', 1],
      ['d2', 3],
    ]);
    expect(notes[1]!.author).toBe('bob');
    expect(notes[0]!.position).toEqual({
      headSha: 'head1',
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      oldLine: null,
      newLine: 10,
    });
    expect(notes[2]!.position.oldLine).toBe(4);
    expect(notes[2]!.position.newLine).toBeNull();
  });

  it('a discussion whose root is a system note is dropped', () => {
    expect(mapDiscussions([{ id: 'x', notes: [note(9, { system: true })] }])).toEqual([]);
  });

  it('a discussion without a root note (empty / null / malformed notes) is dropped, not thrown on (H6)', () => {
    const malformed = [
      { id: 'e1', notes: [] },
      { id: 'e2', notes: null },
      { id: 'e3' },
      { id: 'e4', notes: [null] },
      { id: 'e5', notes: [{ ...note(1), id: 'nope' }] },
      null,
    ] as unknown as RestDiscussion[];
    expect(mapDiscussions([...malformed, FIXTURE[0]!]).map((n) => n.id)).toEqual([1, 2]);
  });
});

describe('toApiPosition (pure, AC-9/AC-10)', () => {
  const base: GitLabTextPosition = {
    baseSha: 'b',
    startSha: 's',
    headSha: 'h',
    oldPath: 'old/name.ts',
    newPath: 'new/name.ts',
    oldLine: null,
    newLine: null,
  };
  it('omits null lines and keeps distinct old/new paths', () => {
    expect(toApiPosition({ ...base, newLine: 5 })).toEqual({
      position_type: 'text',
      base_sha: 'b',
      start_sha: 's',
      head_sha: 'h',
      old_path: 'old/name.ts',
      new_path: 'new/name.ts',
      new_line: 5,
    });
    expect(toApiPosition({ ...base, oldLine: 3 })).not.toHaveProperty('new_line');
    expect(toApiPosition({ ...base, oldLine: 3, newLine: 4 })).toMatchObject({ old_line: 3, new_line: 4 });
  });
});

describe('listDiffNotes (AC-1)', () => {
  it('maps the fixture via GET …/discussions', async () => {
    const { c, calls } = client(() => json(FIXTURE));
    const notes = await c.listDiffNotes(REF, 42);
    expect(notes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(rawPath(calls[0]!)).toBe(`${MR}/discussions`);
    expect(calls[0]!.url.searchParams.get('per_page')).toBe('100');
  });

  it('150 discussions over 2 pages → 150 roots', async () => {
    const all: RestDiscussion[] = Array.from({ length: 150 }, (_, i) => ({
      id: `disc${i}`,
      individual_note: false,
      notes: [note(1000 + i)],
    }));
    const { c, calls } = client((req) => {
      const page = Number(req.url.searchParams.get('page'));
      return page === 1
        ? json(all.slice(0, 100), 200, { 'x-next-page': '2' })
        : json(all.slice(100), 200, { 'x-next-page': '' });
    });
    const notes = await c.listDiffNotes(REF, 42);
    expect(notes).toHaveLength(150);
    expect(notes.every((n) => n.id === n.rootNoteId)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('403 on the project → gitlab_project_inaccessible; 503 → gitlab_comment_failed 502', async () => {
    let err = await caught(client(() => json({ message: '403 Forbidden' }, 403)).c.listDiffNotes(REF, 42));
    expect(err.code).toBe('gitlab_project_inaccessible');
    err = await caught(client(() => json({}, 503)).c.listDiffNotes(REF, 42));
    expect(err.code).toBe('gitlab_comment_failed');
    expect(err.statusCode).toBe(502);
  });
});

describe('getDiffRefs (AC-12)', () => {
  it('reads diff_refs from the MR', async () => {
    const { c, calls } = client(() =>
      json({ iid: 42, diff_refs: { base_sha: 'B', start_sha: 'S', head_sha: 'H' } }),
    );
    expect(await c.getDiffRefs(REF, 42)).toEqual({ baseSha: 'B', startSha: 'S', headSha: 'H' });
    expect(rawPath(calls[0]!)).toBe(MR);
  });

  it('401 → gitlab_token_invalid; 404 → gitlab_project_inaccessible; missing refs → gitlab_comment_failed', async () => {
    expect((await caught(client(() => json({}, 401)).c.getDiffRefs(REF, 42))).code).toBe('gitlab_token_invalid');
    const nf = await caught(client(() => json({}, 404)).c.getDiffRefs(REF, 42));
    expect(nf.code).toBe('gitlab_project_inaccessible');
    expect(nf.statusCode).toBe(404);
    const none = await caught(client(() => json({ iid: 42, diff_refs: null })).c.getDiffRefs(REF, 42));
    expect(none.code).toBe('gitlab_comment_failed');
  });

  it('403 insufficient_scope → gitlab_token_insufficient_scope with the spec message', async () => {
    const err = await caught(
      client(() => json({ error: 'insufficient_scope' }, 403)).c.getDiffRefs(REF, 42),
    );
    expect(err.code).toBe('gitlab_token_insufficient_scope');
    expect(err.message).toBe(
      'This token is missing the api scope. Required scope: api (Reporter role recommended).',
    );
  });
});

describe('getDiscussion (AC-19/AC-20)', () => {
  it('returns id + root note id, URL-encoding the discussion id', async () => {
    const { c, calls } = client(() => json({ id: 'a/b c', notes: [note(11), note(12)] }));
    const d = await c.getDiscussion(REF, 42, 'a/b c');
    expect(d).toMatchObject({ id: 'a/b c', rootNoteId: 11 });
    expect(rawPath(calls[0]!)).toBe(`${MR}/discussions/a%2Fb%20c`);
  });

  it('404 → null', async () => {
    const { c } = client(() => json({ message: '404 Not found' }, 404));
    expect(await c.getDiscussion(REF, 42, 'nope')).toBeNull();
  });
});

describe('createDiffDiscussion (AC-8/9/10)', () => {
  const position: GitLabTextPosition = {
    baseSha: 'B',
    startSha: 'S',
    headSha: 'H',
    oldPath: 'src/old.ts',
    newPath: 'src/new.ts',
    oldLine: null,
    newLine: 7,
  };

  it('POSTs body + text position with only the provided lines; returns the root note', async () => {
    const { c, calls } = client(() =>
      json({ id: 'newdisc', individual_note: false, notes: [note(77, { body: 'Nit' })] }, 201),
    );
    const created = await c.createDiffDiscussion(REF, 42, { body: 'Nit', position });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(rawPath(calls[0]!)).toBe(`${MR}/discussions`);
    expect(calls[0]!.body).toEqual({
      body: 'Nit',
      position: {
        position_type: 'text',
        base_sha: 'B',
        start_sha: 'S',
        head_sha: 'H',
        old_path: 'src/old.ts',
        new_path: 'src/new.ts',
        new_line: 7,
      },
    });
    expect(created).toMatchObject({ id: 77, discussionId: 'newdisc', rootNoteId: 77, body: 'Nit' });
  });

  it('502 → exactly 1 POST and gitlab_comment_failed 502 with the spec message (AC-31)', async () => {
    const { c, calls } = client(() => json({ message: 'Bad gateway' }, 502));
    const err = await caught(c.createDiffDiscussion(REF, 42, { body: 'x', position }));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe('gitlab_comment_failed');
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe(UNCONFIRMED);
  });

  it('timeout → exactly 1 POST, same code (AC-31)', async () => {
    const { c, calls } = client(() => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const err = await caught(c.createDiffDiscussion(REF, 42, { body: 'x', position }));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe('gitlab_comment_failed');
    expect(err.message).toBe(UNCONFIRMED);
  });

  it('429 → 201: 2 POSTs, 1 note', async () => {
    let n = 0;
    const { c, calls } = client(() =>
      ++n === 1
        ? json({}, 429, { 'retry-after': '0' })
        : json({ id: 'd', notes: [note(5)] }, 201),
    );
    expect((await c.createDiffDiscussion(REF, 42, { body: 'x', position })).id).toBe(5);
    expect(calls).toHaveLength(2);
  });

  it('401 → gitlab_token_invalid; locked 403 → gitlab_comment_failed 400 (AC-29/AC-30)', async () => {
    expect((await caught(client(() => json({}, 401)).c.createDiffDiscussion(REF, 42, { body: 'x', position }))).code).toBe(
      'gitlab_token_invalid',
    );
    const locked = await caught(
      client(() => json({ message: '403 Forbidden - discussion is locked' }, 403)).c.createDiffDiscussion(REF, 42, {
        body: 'x',
        position,
      }),
    );
    expect(locked.code).toBe('gitlab_comment_failed');
    expect(locked.statusCode).toBe(400);
    expect(locked.message).toContain('locked');
  });

  it('no error message contains the token (AC-30)', async () => {
    for (const respond of [
      () => json({ message: `PRIVATE-TOKEN: ${TOKEN} denied` }, 403),
      () => json({ message: `400 bad ${TOKEN}` }, 400),
      () => new Response(`upstream ${TOKEN}`, { status: 500 }),
    ]) {
      const err = await caught(client(respond).c.createDiffDiscussion(REF, 42, { body: 'x', position }));
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe('addDiscussionNote (AC-19)', () => {
  it('POSTs to …/discussions/:id/notes and fills the root from a prior getDiscussion', async () => {
    const { c, calls } = client((req) =>
      req.method === 'GET'
        ? json({ id: 'disc1', notes: [note(11), note(12)] })
        : json(note(99, { body: 'reply', position: null }), 201),
    );
    await c.getDiscussion(REF, 42, 'disc1');
    const reply = await c.addDiscussionNote(REF, 42, 'disc1', 'reply');
    const post = calls.find((r) => r.method === 'POST')!;
    expect(rawPath(post)).toBe(`${MR}/discussions/disc1/notes`);
    expect(post.body).toEqual({ body: 'reply' });
    expect(reply).toMatchObject({ id: 99, discussionId: 'disc1', rootNoteId: 11, body: 'reply' });
    expect(reply.position.newLine).toBe(10);
    expect(calls.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('an unknown discussion: the reply\'s own id stands in for the root (H6)', async () => {
    const { c } = client(() => json(note(77, { body: 'r' }), 201));
    const reply = await c.addDiscussionNote(REF, 42, 'never-looked-up', 'r');
    expect(reply).toMatchObject({ id: 77, discussionId: 'never-looked-up', rootNoteId: 77 });
  });

  it('a 201 without a usable note (null, no id, bad id) → unconfirmed, 1 POST each (H6)', async () => {
    for (const body of [null, {}, { id: 'x' }, { id: -1 }]) {
      const { c, calls } = client(() => json(body, 201));
      const err = await caught(c.addDiscussionNote(REF, 42, 'disc1', 'r'));
      expect(err.message).toBe(UNCONFIRMED);
      expect(calls).toHaveLength(1);
    }
  });

  it('5xx → 1 POST, unconfirmed', async () => {
    const { c, calls } = client(() => json({}, 503));
    const err = await caught(c.addDiscussionNote(REF, 42, 'disc1', 'r'));
    expect(calls).toHaveLength(1);
    expect(err.message).toBe(UNCONFIRMED);
  });
});

describe('MockGitLabClient as GitLabCommentsHost', () => {
  it('is writable, records calls, and serves posted notes back', async () => {
    const m = new MockGitLabClient();
    expect(m.readOnly).toBe(false);
    const refs = await m.getDiffRefs(REF, 5);
    expect(refs.headSha).toBe('f00dbabe5');
    expect(await m.getDiscussion(REF, 5, 'unknown')).toBeNull();
    const root = await m.createDiffDiscussion(REF, 5, {
      body: 'hi',
      position: { ...refs, oldPath: 'a', newPath: 'a', oldLine: null, newLine: 2 },
    });
    const found = await m.getDiscussion(REF, 5, root.discussionId);
    expect(found?.rootNoteId).toBe(root.id);
    const reply = await m.addDiscussionNote(REF, 5, root.discussionId, 'r');
    expect(reply.rootNoteId).toBe(root.id);
    expect((await m.listDiffNotes(REF, 5)).map((n) => n.id)).toEqual([root.id, reply.id]);
    expect(m.calls.map((c) => c.kind)).toEqual([
      'diff_refs',
      'discussion',
      'create_discussion',
      'discussion',
      'add_note',
      'discussions',
    ]);
    expect(m.posted.map((p) => p.body)).toEqual(['hi', 'r']);
  });

  it('honours injected errors per call kind', async () => {
    const m = new MockGitLabClient({ errors: { create_discussion: new Error('boom') } });
    await expect(
      m.createDiffDiscussion(REF, 5, {
        body: 'x',
        position: { baseSha: 'b', startSha: 's', headSha: 'h', oldPath: 'a', newPath: 'a', oldLine: 1, newLine: 1 },
      }),
    ).rejects.toThrow('boom');
    expect(m.posted).toHaveLength(0);
  });
});
