/**
 * PrCommentsService with hermetic fakes (spec AC-6, AC-8 – AC-20, AC-29, AC-34).
 * No Postgres, no network: the GitLab host, GitHub client, persisted files and
 * actor lookup are all plain fakes.
 */
import { describe, it, expect } from 'vitest';
import type {
  CreateReviewCommentInput,
  GitHubClient,
  GitLabCommentsHost,
  GitLabDiffNote,
  GitLabDiffRefs,
  GitLabDiscussionRef,
  GitLabTextPosition,
  HostCommentInput,
  HostRepoRef,
  PrReviewComment,
} from '@devdigest/shared';
import {
  PrCommentsService,
  type CommentsPr,
  type PrCommentsDeps,
} from '../src/modules/pulls/comments-service.js';
import type { PersistedFileLike } from '../src/modules/pulls/comment-position.js';
import { AppError } from '../src/platform/errors.js';

const TOKEN = 'glpat-SECRET-token-value';
const REFS: GitLabDiffRefs = { baseSha: 'base-1', startSha: 'start-1', headSha: 'head-1' };

const glRepo = { owner: 'group/sub', name: 'project', fullName: 'group/sub/project', provider: 'gitlab', host: 'gitlab.com' };
const ghRepo = { owner: 'acme', name: 'api', fullName: 'acme/api' };
const pr: CommentsPr = { id: 'pr-uuid', number: 42, headSha: 'head-1', detailHeadSha: 'head-1' };

const FILES: PersistedFileLike[] = [
  {
    path: 'src/a.ts',
    patch: '@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx2\n',
    previousPath: null,
    patchOmitted: null,
  },
];

class FakeGitLab implements GitLabCommentsHost {
  calls: string[] = [];
  created: { body: string; position: GitLabTextPosition }[] = [];
  notesAdded: { discussionId: string; body: string }[] = [];
  refs: GitLabDiffRefs = REFS;
  discussions = new Map<string, GitLabDiscussionRef>();
  notes: GitLabDiffNote[] = [];
  listError: Error | null = null;

  listDiffNotes = async (_ref: HostRepoRef, _iid: number) => {
    this.calls.push('listDiffNotes');
    if (this.listError) throw this.listError;
    return this.notes;
  };
  getDiffRefs = async (_ref: HostRepoRef, _iid: number) => {
    this.calls.push('getDiffRefs');
    return this.refs;
  };
  getDiscussion = async (_ref: HostRepoRef, _iid: number, id: string) => {
    this.calls.push('getDiscussion');
    return this.discussions.get(id) ?? null;
  };
  createDiffDiscussion = async (
    _ref: HostRepoRef,
    _iid: number,
    input: { body: string; position: GitLabTextPosition },
  ): Promise<GitLabDiffNote> => {
    this.calls.push('createDiffDiscussion');
    this.created.push(input);
    return {
      id: 900,
      discussionId: 'new-disc',
      rootNoteId: 900,
      author: 'devdigest-bot',
      body: input.body,
      createdAt: '2026-10-20T00:00:00Z',
      position: {
        headSha: input.position.headSha,
        oldPath: input.position.oldPath,
        newPath: input.position.newPath,
        oldLine: input.position.oldLine,
        newLine: input.position.newLine,
      },
    };
  };
  addDiscussionNote = async (_ref: HostRepoRef, _iid: number, discussionId: string, body: string) => {
    this.calls.push('addDiscussionNote');
    this.notesAdded.push({ discussionId, body });
    // GitLab's add-note response carries no root note id (Q3).
    return {
      id: 901,
      discussionId,
      rootNoteId: 901,
      author: 'devdigest-bot',
      body,
      createdAt: '2026-10-20T00:00:00Z',
      position: { headSha: 'head-1', oldPath: null, newPath: null, oldLine: null, newLine: null },
    } satisfies GitLabDiffNote;
  };
  checkTokenScopes = async () => ({ kind: 'ok' as const, username: 'devdigest-bot', scopes: ['api'] });
}

class FakeGitHub {
  created: CreateReviewCommentInput[] = [];
  comments: PrReviewComment[] = [];
  failWith: unknown = null;
  async listReviewComments() {
    return this.comments;
  }
  async createReviewComment(_repo: unknown, _n: number, input: CreateReviewCommentInput): Promise<PrReviewComment> {
    if (this.failWith) throw this.failWith;
    this.created.push(input);
    return {
      id: 7,
      path: input.path,
      line: input.line,
      original_line: input.line,
      side: input.side ?? 'RIGHT',
      body: input.body,
      user: 'bot',
      created_at: 'now',
      html_url: 'https://github.com/acme/api/pull/42#discussion_r7',
      in_reply_to_id: input.inReplyTo ?? null,
      is_outdated: false,
    };
  }
}

interface Logged {
  obj: unknown;
  msg?: string;
}

function setup(
  over: Partial<PrCommentsDeps> & { token?: boolean } = {},
): { svc: PrCommentsService; gl: FakeGitLab; gh: FakeGitHub; logs: Logged[]; log: { warn: (o: unknown, m?: string) => void } } {
  const gl = new FakeGitLab();
  const gh = new FakeGitHub();
  const logs: Logged[] = [];
  const hasToken = over.token ?? true;
  const svc = new PrCommentsService({
    github: async () => gh as unknown as GitHubClient,
    gitlabAccess: {
      resolve: async () => (hasToken ? { host: gl, serviceAccount: 'devdigest-bot' } : null),
    },
    files: async () => FILES,
    actorName: async () => ({ name: 'Jane Doe', email: 'jane@example.com' }),
    footerEnabled: false,
    ...over,
  });
  return { svc, gl, gh, logs, log: { warn: (obj, msg) => logs.push({ obj, msg }) } };
}

function input(over: Partial<HostCommentInput> = {}): HostCommentInput {
  return { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Nit', ...over };
}

async function rejectsWith(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).statusCode).toBe(status);
}

describe('PrCommentsService — GitLab create', () => {
  it('posts one discussion with the current refs and the resolved anchor (AC-8, AC-9)', async () => {
    const { svc, gl } = setup();
    const c = await svc.create(pr, glRepo, input(), 'user-1');
    expect(gl.calls).toEqual(['getDiffRefs', 'createDiffDiscussion']);
    expect(gl.created[0]).toEqual({
      body: 'Nit',
      position: {
        baseSha: 'base-1',
        startSha: 'start-1',
        headSha: 'head-1',
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        oldLine: null,
        newLine: 2,
      },
    });
    expect(c).toMatchObject({ id: 900, discussion_id: 'new-disc', provider: 'gitlab', side: 'RIGHT', line: 2, in_reply_to_id: null });
  });

  it('rejects an invalid position with 0 host calls (AC-11)', async () => {
    const { svc, gl } = setup();
    await rejectsWith(svc.create(pr, glRepo, input({ line: 99 }), 'u'), 'comment_position_invalid', 400);
    await rejectsWith(svc.create(pr, glRepo, input({ path: 'nope.ts' }), 'u'), 'comment_position_invalid', 400);
    expect(gl.calls).toEqual([]);
  });

  it('rejects when the head moved: 1 read, 0 writes (AC-12)', async () => {
    const { svc, gl } = setup();
    gl.refs = { ...REFS, headSha: 'head-2' };
    await rejectsWith(svc.create(pr, glRepo, input(), 'u'), 'comment_diff_outdated', 409);
    expect(gl.calls).toEqual(['getDiffRefs']);
    gl.discussions.set('d1', { id: 'd1', rootNoteId: 500, position: null });
    gl.calls = [];
    await rejectsWith(svc.create(pr, glRepo, input({ discussion_id: 'd1' }), 'u'), 'comment_diff_outdated', 409);
    expect(gl.calls).toEqual(['getDiffRefs']);
  });

  it('neutralises quick actions in the sent text (AC-13)', async () => {
    const { svc, gl } = setup();
    await svc.create(pr, glRepo, input({ body: '/merge\n/close\nLGTM' }), 'u');
    expect(gl.created[0]!.body).toBe('\\/merge\n\\/close\nLGTM');
  });

  it('appends the footer only when enabled (AC-16, AC-17)', async () => {
    const on = setup({ footerEnabled: true });
    const c = await on.svc.create(pr, glRepo, input(), 'user-1');
    expect(on.gl.created[0]!.body).toBe('Nit\n\n— posted by `Jane Doe` via DevDigest');
    // Read back: the service account's footer is stripped into the attribution (AC-7).
    expect(c).toMatchObject({ body: 'Nit', devdigest_attribution: { name: 'Jane Doe' } });

    const off = setup({ footerEnabled: false });
    await off.svc.create(pr, glRepo, input(), 'user-1');
    expect(off.gl.created[0]!.body).toBe('Nit');

    const fallback = setup({ footerEnabled: true, actorName: async () => null });
    await fallback.svc.create(pr, glRepo, input(), null);
    expect(fallback.gl.created[0]!.body).toContain('`a DevDigest user`');
  });

  it('rejects text over the limit with 0 calls; the footer counts (AC-15)', async () => {
    const footerLen = '\n\n— posted by `Jane Doe` via DevDigest'.length;
    const body = 'x'.repeat(1000 - footerLen + 1);
    const on = setup({ footerEnabled: true, maxChars: 1000 });
    await rejectsWith(on.svc.create(pr, glRepo, input({ body }), 'u'), 'comment_too_long', 400);
    expect(on.gl.calls).toEqual([]);
    const off = setup({ footerEnabled: false, maxChars: 1000 });
    await off.svc.create(pr, glRepo, input({ body }), 'u');
    expect(off.gl.calls).toEqual(['getDiffRefs', 'createDiffDiscussion']);
    // Default limit = GitLab's 1,000,000.
    const big = setup();
    await rejectsWith(big.svc.create(pr, glRepo, input({ body: 'y'.repeat(1_000_001) }), 'u'), 'comment_too_long', 400);
    expect(big.gl.calls).toEqual([]);
  });

  it('replies to an existing discussion with the root id (AC-19)', async () => {
    const { svc, gl } = setup();
    gl.discussions.set('d1', {
      id: 'd1',
      rootNoteId: 500,
      position: { headSha: 'head-1', oldPath: 'src/a.ts', newPath: 'src/a.ts', oldLine: null, newLine: 2 },
    });
    // A reply does not need a line in the persisted diff.
    const c = await svc.create(pr, glRepo, input({ discussion_id: 'd1', line: 999 }), 'u');
    expect(gl.calls).toEqual(['getDiffRefs', 'getDiscussion', 'addDiscussionNote']);
    expect(gl.notesAdded).toEqual([{ discussionId: 'd1', body: 'Nit' }]);
    expect(c).toMatchObject({ id: 901, in_reply_to_id: 500, discussion_id: 'd1', path: 'src/a.ts', line: 2 });
  });

  it('a reply to a missing discussion → 404, 0 writes (AC-20)', async () => {
    const { svc, gl } = setup();
    await rejectsWith(svc.create(pr, glRepo, input({ discussion_id: 'gone' }), 'u'), 'comment_thread_not_found', 404);
    expect(gl.calls).toEqual(['getDiffRefs', 'getDiscussion']);
  });

  it('a reply without discussion_id → validation_error, 0 calls (Q5)', async () => {
    const { svc, gl } = setup();
    await rejectsWith(svc.create(pr, glRepo, input({ in_reply_to: 5 }), 'u'), 'validation_error', 400);
    expect(gl.calls).toEqual([]);
  });

  it('no token → gitlab_token_missing, 0 calls (AC-29); gate errors propagate (AC-23)', async () => {
    const none = setup({ token: false });
    await rejectsWith(none.svc.create(pr, glRepo, input(), 'u'), 'gitlab_token_missing', 400);
    expect(none.gl.calls).toEqual([]);

    const gated = setup({
      gitlabAccess: {
        resolve: async () => {
          throw new AppError('gitlab_token_insufficient_scope', 'missing api', 400);
        },
      },
    });
    await rejectsWith(gated.svc.create(pr, glRepo, input(), 'u'), 'gitlab_token_insufficient_scope', 400);
    expect(gated.gl.calls).toEqual([]);
  });

  it('a blank body → 400, no host call (AC-14)', async () => {
    const { svc, gl, gh } = setup();
    await rejectsWith(svc.create(pr, glRepo, input({ body: '   ' }), 'u'), 'validation_error', 400);
    await rejectsWith(svc.create(pr, ghRepo, input({ body: '\n\t' }), 'u'), 'validation_error', 400);
    expect(gl.calls).toEqual([]);
    expect(gh.created).toEqual([]);
  });
});

describe('PrCommentsService — GitLab list', () => {
  it('maps notes against the current head', async () => {
    const { svc, gl } = setup();
    gl.notes = [
      {
        id: 1,
        discussionId: 'd',
        rootNoteId: 1,
        author: 'alice',
        body: 'root',
        createdAt: 't',
        position: { headSha: 'head-1', oldPath: 'a', newPath: 'a', oldLine: null, newLine: 3 },
      },
      {
        id: 2,
        discussionId: 'd',
        rootNoteId: 1,
        author: 'bob',
        body: 'reply',
        createdAt: 't',
        position: { headSha: 'head-0', oldPath: 'a', newPath: 'a', oldLine: null, newLine: 3 },
      },
    ];
    const out = await svc.list(pr, glRepo);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ in_reply_to_id: null, line: 3, is_outdated: false });
    expect(out[1]).toMatchObject({ in_reply_to_id: 1, line: null, is_outdated: true });
    expect(out[0]!.html_url).toBe('https://gitlab.com/group/sub/project/-/merge_requests/42#note_1');
  });

  it('any failure → [] and a secret-free warning (AC-6)', async () => {
    const { svc, gl, logs, log } = setup();
    const err = Object.assign(new Error(`GET failed with PRIVATE-TOKEN ${TOKEN}`), {
      code: 'gitlab_comment_failed',
      upstreamStatus: 503,
    });
    gl.listError = err;
    expect(await svc.list(pr, glRepo, log)).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.obj).toMatchObject({ code: 'gitlab_comment_failed', upstreamStatus: 503 });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);

    const gated = setup({
      gitlabAccess: {
        resolve: async () => {
          throw new AppError('gitlab_token_insufficient_scope', 'missing api', 400);
        },
      },
    });
    expect(await gated.svc.list(pr, glRepo, gated.log)).toEqual([]);
    expect(gated.logs[0]!.obj).toMatchObject({ code: 'gitlab_token_insufficient_scope' });
  });

  it('no token → [] without host calls', async () => {
    const { svc, gl } = setup({ token: false });
    expect(await svc.list(pr, glRepo)).toEqual([]);
    expect(gl.calls).toEqual([]);
  });
});

describe('PrCommentsService — GitHub (AC-34)', () => {
  it('keeps the request mapping and ignores discussion_id; never adds a footer', async () => {
    const { svc, gh, gl } = setup({ footerEnabled: true });
    const c = await svc.create(pr, ghRepo, input({ body: '/merge', side: 'LEFT', discussion_id: 'x' }), 'u');
    expect(gh.created).toEqual([{ commitId: 'head-1', path: 'src/a.ts', line: 2, side: 'LEFT', body: '/merge' }]);
    expect(c).toMatchObject({ id: 7, provider: 'github' });
    await svc.create(pr, ghRepo, input({ in_reply_to: 3 }), 'u');
    expect(gh.created[1]).toEqual({ commitId: 'head-1', path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Nit', inReplyTo: 3 });
    expect(gl.calls).toEqual([]);
  });

  it('maps failures: no client → github_unavailable; AppError passes; other → github_comment_failed', async () => {
    const noClient = setup({
      github: async () => {
        throw new Error('no token');
      },
    });
    await rejectsWith(noClient.svc.create(pr, ghRepo, input(), 'u'), 'github_unavailable', 400);

    const { svc, gh } = setup();
    gh.failWith = new AppError('github_comment_failed', "GitHub didn't confirm the comment", 502);
    await rejectsWith(svc.create(pr, ghRepo, input(), 'u'), 'github_comment_failed', 502);
    gh.failWith = new Error('Validation Failed');
    await rejectsWith(svc.create(pr, ghRepo, input(), 'u'), 'github_comment_failed', 400);
  });

  it('lists comments tagged github; failures → []', async () => {
    const { svc, gh } = setup();
    gh.comments = [
      {
        id: 1,
        path: 'a',
        line: 1,
        original_line: 1,
        side: 'RIGHT',
        body: 'b',
        user: 'u',
        created_at: 't',
        html_url: 'h',
        in_reply_to_id: null,
        is_outdated: false,
      },
    ];
    expect(await svc.list(pr, ghRepo)).toEqual([{ ...gh.comments[0], provider: 'github' }]);
    const broken = setup({
      github: async () => {
        throw new Error('offline');
      },
    });
    expect(await broken.svc.list(pr, ghRepo)).toEqual([]);
  });
});
