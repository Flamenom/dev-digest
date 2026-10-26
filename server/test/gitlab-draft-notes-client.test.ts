/**
 * RestGitLabClient as `GitLabDraftNotesHost` (plan gitlab-publish-findings T3):
 * own-draft listing (AC-23), draft creation with positions (AC-9/AC-11/AC-25),
 * idempotent delete (AC-30), bulk publish (AC-26/AC-32), all-notes read-back
 * (AC-26), write classification (AC-28 – AC-32) and token redaction. Plus the
 * pure mappers and the mock. Hermetic fake fetch + fake sleep.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { GitLabDraftPosition, HostRepoRef, WaitBudget } from '@devdigest/shared';
import { RestGitLabClient } from '../src/adapters/gitlab/client.js';
import { mapMrNotes, toApiDraftPosition, type RestDiscussion } from '../src/adapters/gitlab/index.js';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { fakeFetch, fakeSleep, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-DRAFTS-SECRET';
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

const rawPath = (r: FakeRequest) => r.url.href.replace('https://gitlab.com/api/v4', '').split('?')[0];
const budget = (ms = 60_000): WaitBudget => ({ remainingMs: ms });

function client(handler: (req: FakeRequest) => Response | Promise<Response>) {
  const { fetch, calls } = fakeFetch(handler);
  const { sleep, delays } = fakeSleep();
  const c = new RestGitLabClient({ token: TOKEN, fetch, sleep, random: () => 0.5 });
  return { c, calls, delays };
}

async function caught(p: Promise<unknown>): Promise<Error & { code?: string; statusCode?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; statusCode?: number };
  }
  throw new Error('expected a rejection');
}

const POS: GitLabDraftPosition = {
  baseSha: 'B',
  startSha: 'S',
  headSha: 'H',
  oldPath: 'src/old.ts',
  newPath: 'src/new.ts',
  oldLine: null,
  newLine: 12,
};
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

describe('toApiDraftPosition (pure, AC-11)', () => {
  it('single line: text position, null lines omitted, no line_range', () => {
    const out = toApiDraftPosition(POS);
    expect(out).toEqual({
      position_type: 'text',
      base_sha: 'B',
      start_sha: 'S',
      head_sha: 'H',
      old_path: 'src/old.ts',
      new_path: 'src/new.ts',
      new_line: 12,
    });
  });

  it('multi-line: line_range with both ends; context end carries old+new, type null; added start is type new', () => {
    const out = toApiDraftPosition({
      ...POS,
      oldLine: 9,
      newLine: 12,
      lineRange: { start: { oldLine: null, newLine: 10 }, end: { oldLine: 9, newLine: 12 } },
    });
    expect(out.line_range).toEqual({
      start: { line_code: `${sha1('src/new.ts')}__10`, type: 'new', new_line: 10 },
      end: { line_code: `${sha1('src/new.ts')}_9_12`, type: null, old_line: 9, new_line: 12 },
    });
    expect(out).toMatchObject({ old_line: 9, new_line: 12 });
  });
});

describe('mapMrNotes (pure, AC-26)', () => {
  it('keeps every non-system note of diff AND general discussions; drops malformed', () => {
    const raw = [
      { id: 'd1', individual_note: false, notes: [{ id: 1, type: 'DiffNote', body: 'a', author: { username: 'bot' } }] },
      { id: 'd2', individual_note: true, notes: [{ id: 2, type: null, body: 'general', author: { username: 'bot' } }] },
      { id: 'd3', individual_note: true, notes: [{ id: 3, system: true, body: 'changed' }] },
      { id: 'd4', notes: [null, { id: 'x' }, { id: 4, body: null, author: null }] },
      { id: '', notes: [{ id: 5 }] },
      null,
    ] as unknown as RestDiscussion[];
    expect(mapMrNotes(raw)).toEqual([
      { id: 1, discussionId: 'd1', author: 'bot', body: 'a', system: false },
      { id: 2, discussionId: 'd2', author: 'bot', body: 'general', system: false },
      { id: 4, discussionId: 'd4', author: 'unknown', body: '', system: false },
    ]);
  });
});

describe('listOwnDraftNotes (AC-23)', () => {
  it('paginates GET …/draft_notes and drops malformed drafts', async () => {
    const { c, calls } = client((req) =>
      Number(req.url.searchParams.get('page')) === 1
        ? json([{ id: 1, note: 'a' }, { id: 'bad', note: 'x' }], 200, { 'x-next-page': '2' })
        : json([{ id: 2, note: 'b' }], 200, { 'x-next-page': '' }),
    );
    expect(await c.listOwnDraftNotes(REF, 42)).toEqual([
      { id: 1, note: 'a' },
      { id: 2, note: 'b' },
    ]);
    expect(calls).toHaveLength(2);
    expect(rawPath(calls[0]!)).toBe(`${MR}/draft_notes`);
    expect(calls.every((r) => r.method === 'GET')).toBe(true);
  });

  it('a failure is a mapped AppError (403 → gitlab_project_inaccessible)', async () => {
    const err = await caught(client(() => json({ message: '403 Forbidden' }, 403)).c.listOwnDraftNotes(REF, 42));
    expect(err.code).toBe('gitlab_project_inaccessible');
  });
});

describe('createDraftNote (AC-9/AC-11/AC-25/AC-28/AC-30)', () => {
  it('unpositioned create sends no position key (general note)', async () => {
    const { c, calls } = client(() => json({ id: 77, note: 'hello' }, 201));
    const res = await c.createDraftNote(REF, 42, { note: 'hello', position: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: true, value: { id: 77, note: 'hello' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(rawPath(calls[0]!)).toBe(`${MR}/draft_notes`);
    expect(calls[0]!.body).toEqual({ note: 'hello' });
    expect(calls[0]!.body).not.toHaveProperty('position');
  });

  it('multi-line create sends line_range with both ends; a context line carries old_line + new_line', async () => {
    const { c, calls } = client(() => json({ id: 78, note: 'n' }, 201));
    await c.createDraftNote(
      REF,
      42,
      {
        note: 'n',
        position: {
          ...POS,
          oldLine: 8,
          newLine: 11,
          lineRange: { start: { oldLine: 7, newLine: 10 }, end: { oldLine: 8, newLine: 11 } },
        },
      },
      { waitBudget: budget() },
    );
    const pos = (calls[0]!.body as unknown as { position: Record<string, unknown> }).position;
    expect(pos).toMatchObject({ position_type: 'text', old_line: 8, new_line: 11, head_sha: 'H' });
    expect(pos.line_range).toEqual({
      start: { line_code: `${sha1('src/new.ts')}_7_10`, type: null, old_line: 7, new_line: 10 },
      end: { line_code: `${sha1('src/new.ts')}_8_11`, type: null, old_line: 8, new_line: 11 },
    });
  });

  it('429 (Retry-After: 1) → 201: 2 POSTs, ok, budget reduced by 1000 ms', async () => {
    let n = 0;
    const { c, calls, delays } = client(() =>
      ++n === 1 ? json({}, 429, { 'retry-after': '1' }) : json({ id: 5, note: 'x' }, 201),
    );
    const b = budget();
    const res = await c.createDraftNote(REF, 42, { note: 'x', position: null }, { waitBudget: b });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
    expect(b.remainingMs).toBe(59_000);
  });

  it('persistent 429 → rate_limited after ≤ 4 POSTs', async () => {
    const { c, calls } = client(() => json({}, 429, { 'retry-after': '1' }));
    const res = await c.createDraftNote(REF, 42, { note: 'x', position: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: false, failure: { kind: 'rate_limited' } });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('two creates sharing a 1500 ms budget with Retry-After: 1 → the second exhausts it', async () => {
    let n = 0;
    // create #1: 429 then 201; create #2: always 429.
    const { c, calls, delays } = client(() =>
      ++n === 2 ? json({ id: 9, note: 'a' }, 201) : json({}, 429, { 'retry-after': '1' }),
    );
    const b = budget(1500);
    const first = await c.createDraftNote(REF, 42, { note: 'a', position: null }, { waitBudget: b });
    expect(first.ok).toBe(true);
    expect(b.remainingMs).toBe(500);
    const second = await c.createDraftNote(REF, 42, { note: 'b', position: null }, { waitBudget: b });
    expect(second).toEqual({ ok: false, failure: { kind: 'rate_limited' } });
    expect(b.remainingMs).toBe(0);
    expect(delays).toEqual([1000, 500]);
    expect(calls).toHaveLength(4);
  });

  it.each([502, 503, 500])('%i → exactly 1 POST, unconfirmed (may have landed)', async (status) => {
    const { c, calls } = client(() => json({ message: 'boom' }, status));
    const res = await c.createDraftNote(REF, 42, { note: 'x', position: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
    expect(calls).toHaveLength(1);
  });

  it('timeout / network error → exactly 1 POST, unconfirmed', async () => {
    for (const thrown of [
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
      new TypeError('fetch failed'),
    ]) {
      const fetch = vi.fn(async () => {
        throw thrown;
      });
      const c = new RestGitLabClient({ token: TOKEN, fetch, sleep: fakeSleep().sleep });
      const res = await c.createDraftNote(REF, 42, { note: 'x', position: null }, { waitBudget: budget() });
      expect(res).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('an unreadable 2xx (non-JSON / malformed draft) → unconfirmed', async () => {
    let res = await client(() => new Response('<html>', { status: 201 })).c.createDraftNote(
      REF, 42, { note: 'x', position: null }, { waitBudget: budget() },
    );
    expect(res).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
    res = await client(() => json({ id: 'nope' }, 201)).c.createDraftNote(
      REF, 42, { note: 'x', position: null }, { waitBudget: budget() },
    );
    expect(res).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
  });

  it.each([
    [400, { kind: 'rejected', status: 400 }],
    [422, { kind: 'rejected', status: 422 }],
    [401, { kind: 'token_invalid' }],
    [403, { kind: 'forbidden' }],
    [404, { kind: 'not_found' }],
  ] as const)('%i → exactly 1 POST, %j', async (status, failure) => {
    const { c, calls } = client(() => json({ message: `${status} ${TOKEN}` }, status));
    const res = await c.createDraftNote(REF, 42, { note: 'x', position: POS }, { waitBudget: budget() });
    expect(res).toEqual({ ok: false, failure });
    expect(calls).toHaveLength(1);
  });

  it('403 insufficient_scope → insufficient_scope', async () => {
    const { c } = client(() =>
      json({ error: 'insufficient_scope' }, 403, { 'www-authenticate': 'Bearer error="insufficient_scope"' }),
    );
    const res = await c.createDraftNote(REF, 42, { note: 'x', position: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: false, failure: { kind: 'insufficient_scope' } });
  });

  it('an invalid iid never sends a request and never throws', async () => {
    const { c, calls } = client(() => json({ id: 1, note: 'x' }, 201));
    const res = await c.createDraftNote(REF, 0, { note: 'x', position: null }, { waitBudget: budget() });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('deleteDraftNote (AC-30, idempotent)', () => {
  it('DELETE …/draft_notes/:id: 503 → 204 is retried → deleted', async () => {
    let n = 0;
    const { c, calls } = client(() => (++n === 1 ? json({}, 503) : new Response(null, { status: 204 })));
    expect(await c.deleteDraftNote(REF, 42, 77)).toBe('deleted');
    expect(calls).toHaveLength(2);
    expect(calls.every((r) => r.method === 'DELETE')).toBe(true);
    expect(rawPath(calls[0]!)).toBe(`${MR}/draft_notes/77`);
  });

  it("404 → 'not_found'; a persistent 503 throws a mapped error", async () => {
    expect(await client(() => json({ message: '404 Not found' }, 404)).c.deleteDraftNote(REF, 42, 77)).toBe(
      'not_found',
    );
    const err = await caught(client(() => json({}, 503)).c.deleteDraftNote(REF, 42, 77));
    expect(err.code).toBe('gitlab_comment_failed');
    expect(err.statusCode).toBe(502);
  });

  it('a non-positive draft id is rejected before any request', async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    const err = await caught(c.deleteDraftNote(REF, 42, -1));
    expect(err.code).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });
});

describe('bulkPublishDraftNotes (AC-26/AC-32)', () => {
  it('note null → sends {} (never reviewer_state / internal); 204 → ok', async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    const res = await c.bulkPublishDraftNotes(REF, 42, { note: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: true, value: null });
    expect(rawPath(calls[0]!)).toBe(`${MR}/draft_notes/bulk_publish`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({});
  });

  it('with a summary → sends only { note }', async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.bulkPublishDraftNotes(REF, 42, { note: 'Summary' }, { waitBudget: budget() });
    expect(calls[0]!.body).toEqual({ note: 'Summary' });
    expect(Object.keys(calls[0]!.body ?? {})).not.toContain('reviewer_state');
    expect(Object.keys(calls[0]!.body ?? {})).not.toContain('internal');
  });

  it('504 → exactly 1 POST, unconfirmed', async () => {
    const { c, calls } = client(() => json({}, 504));
    const res = await c.bulkPublishDraftNotes(REF, 42, { note: null }, { waitBudget: budget() });
    expect(res).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
    expect(calls).toHaveLength(1);
  });
});

describe('listMrNotes (AC-26)', () => {
  it('2 pages with a diff discussion, a general note and a system note → the non-system notes of both kinds', async () => {
    const page1 = [
      {
        id: 'diff1',
        individual_note: false,
        notes: [{ id: 11, type: 'DiffNote', body: 'on a line', author: { username: 'devdigest-bot' } }],
      },
      { id: 'sys1', individual_note: true, notes: [{ id: 12, system: true, body: 'added 1 commit' }] },
    ];
    const page2 = [
      { id: 'gen1', individual_note: true, notes: [{ id: 13, type: null, body: 'general', author: { username: 'devdigest-bot' } }] },
    ];
    const { c, calls } = client((req) =>
      Number(req.url.searchParams.get('page')) === 1
        ? json(page1, 200, { 'x-next-page': '2' })
        : json(page2, 200, { 'x-next-page': '' }),
    );
    const notes = await c.listMrNotes(REF, 42);
    expect(notes.map((n) => [n.id, n.discussionId])).toEqual([
      [11, 'diff1'],
      [13, 'gen1'],
    ]);
    expect(calls).toHaveLength(2);
    expect(rawPath(calls[0]!)).toBe(`${MR}/discussions`);
  });
});

describe('redaction', () => {
  it('no read/delete error message contains the token', async () => {
    const leaky = () => json({ message: `bad token ${TOKEN}` }, 400);
    for (const p of [
      client(leaky).c.listOwnDraftNotes(REF, 42),
      client(leaky).c.listMrNotes(REF, 42),
      client(leaky).c.deleteDraftNote(REF, 42, 5),
    ]) {
      const err = await caught(p);
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe('MockGitLabClient as GitLabDraftNotesHost', () => {
  it('own drafts only; bulk publish moves own drafts (+summary) into notes; others stay', async () => {
    const mock = new MockGitLabClient({
      drafts: { 42: [{ id: 1, author: 'alice', note: 'human draft', position: null }] },
    });
    expect(await mock.listOwnDraftNotes(REF, 42)).toEqual([]);
    const created = await mock.createDraftNote(REF, 42, { note: 'f1', position: POS }, { waitBudget: budget() });
    expect(created.ok).toBe(true);
    expect((await mock.listOwnDraftNotes(REF, 42)).map((d) => d.note)).toEqual(['f1']);
    expect(await mock.deleteDraftNote(REF, 42, 1)).toBe('not_found'); // another author's draft

    expect(await mock.bulkPublishDraftNotes(REF, 42, { note: 'sum' }, { waitBudget: budget() })).toEqual({
      ok: true,
      value: null,
    });
    expect((await mock.listMrNotes(REF, 42)).map((n) => [n.body, n.author])).toEqual([
      ['f1', 'devdigest-bot'],
      ['sum', 'devdigest-bot'],
    ]);
    expect(await mock.listOwnDraftNotes(REF, 42)).toEqual([]);
    expect(mock.opts.drafts?.[42]?.map((d) => d.author)).toEqual(['alice']);
    expect(mock.callsOf('bulk_publish')).toHaveLength(1);
  });

  it('scripted failures: rejected (nothing stored) and unconfirmed-but-landed', async () => {
    const mock = new MockGitLabClient({
      writeScript: {
        create_draft_note: [{ failure: { kind: 'rejected', status: 400 } }, { failure: { kind: 'unconfirmed' }, landed: true }],
      },
    });
    const a = await mock.createDraftNote(REF, 42, { note: 'a', position: null }, { waitBudget: budget() });
    expect(a).toEqual({ ok: false, failure: { kind: 'rejected', status: 400 } });
    const b = await mock.createDraftNote(REF, 42, { note: 'b', position: null }, { waitBudget: budget() });
    expect(b).toEqual({ ok: false, failure: { kind: 'unconfirmed' } });
    expect((await mock.listOwnDraftNotes(REF, 42)).map((d) => d.note)).toEqual(['b']);
    const c = await mock.createDraftNote(REF, 42, { note: 'c', position: null }, { waitBudget: budget() });
    expect(c.ok).toBe(true);
    expect(mock.draftWrites.filter((w) => w.kind === 'create_draft_note')).toHaveLength(3);
  });
});
