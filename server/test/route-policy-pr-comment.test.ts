import { describe, it, expect, afterEach } from 'vitest';
import type { PrComments } from '../src/modules/pulls/comments-service.js';
import { PrCommentAuditMetadata } from '../src/vendor/shared/index.js';
import { ROUTE_POLICY, type AuditContext } from '../src/platform/auth/route-policy.js';
import {
  anonymous,
  asSession,
  buildHermeticGoogleApp,
  TEST_UUID,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

/**
 * `POST /pulls/:id/comments` policy (spec 2026-10-20-gitlab-comments):
 *  - AC-41: Member access; an unauthenticated request is 401 with no host call;
 *  - AC-42: the `pr_comment.create` descriptor — target `pull_request` / PR uuid,
 *    metadata `{ provider, host_comment_id, discussion_id?, is_reply }`, never the body;
 *  - AC-14: a whitespace-only body is 400 before any host is resolved.
 * Hermetic: fake principals, a DB that is never reached on these paths.
 */

const POLICY = ROUTE_POLICY['POST /pulls/:id/comments']!;
const BODY_TEXT = 'Please extract this — secret-looking body text';

function ctx(body: unknown, response: unknown): AuditContext {
  return { params: { id: TEST_UUID }, body, response: () => response };
}

describe('pr_comment.create descriptor (AC-42)', () => {
  it('is a member route audited as pr_comment.create on the PR uuid', () => {
    expect(POLICY.access).toBe('member');
    expect(POLICY.audit?.action).toBe('pr_comment.create');
    expect(POLICY.audit?.targetType).toBe('pull_request');
    // Default target id = params.id (the PR uuid).
    expect(POLICY.audit?.targetId).toBeUndefined();
  });

  it('GitHub post / reply and GitLab post / reply → strict metadata, never the body', () => {
    const metadata = POLICY.audit!.metadata!;
    const cases: Array<[unknown, unknown, PrCommentAuditMetadata]> = [
      [
        { path: 'a.ts', line: 1, body: BODY_TEXT },
        { id: 11, body: BODY_TEXT, provider: 'github' },
        { provider: 'github', host_comment_id: 11, is_reply: false },
      ],
      [
        { path: 'a.ts', line: 1, body: BODY_TEXT, in_reply_to: 11 },
        // Legacy GitHub response without `provider` → github.
        { id: 12, body: BODY_TEXT },
        { provider: 'github', host_comment_id: 12, is_reply: true },
      ],
      [
        { path: 'a.ts', line: 1, body: BODY_TEXT },
        { id: 901, body: BODY_TEXT, provider: 'gitlab', discussion_id: 'abc123' },
        { provider: 'gitlab', host_comment_id: 901, discussion_id: 'abc123', is_reply: false },
      ],
      [
        { path: 'a.ts', line: 1, body: BODY_TEXT, discussion_id: 'abc123' },
        { id: 902, body: BODY_TEXT, provider: 'gitlab', discussion_id: 'abc123', in_reply_to_id: 901 },
        { provider: 'gitlab', host_comment_id: 902, discussion_id: 'abc123', is_reply: true },
      ],
    ];
    for (const [body, response, expected] of cases) {
      const out = metadata(ctx(body, response));
      expect(out).toEqual(expected);
      expect(PrCommentAuditMetadata.safeParse(out).success).toBe(true);
      expect(JSON.stringify(out)).not.toContain(BODY_TEXT);
    }
  });

  it('a response without a numeric id yields no metadata (nothing invented)', () => {
    const metadata = POLICY.audit!.metadata!;
    expect(metadata(ctx({}, undefined))).toBeUndefined();
    expect(metadata(ctx({}, { id: 'x' }))).toBeUndefined();
  });
});

describe('POST /pulls/:id/comments at the HTTP edge (google mode)', () => {
  let t: HermeticGoogleApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  function countingComments() {
    const calls: string[] = [];
    const prComments: PrComments = {
      list: async () => {
        calls.push('list');
        return [];
      },
      create: async () => {
        calls.push('create');
        throw new Error('must not be reached');
      },
    };
    return { prComments, calls };
  }

  it('no session → 401 and the comments use case is never reached (AC-41)', async () => {
    const { prComments, calls } = countingComments();
    t = await buildHermeticGoogleApp({ overrides: { prComments } });
    const res = await t.app.inject(
      anonymous({
        method: 'POST',
        url: `/pulls/${TEST_UUID}/comments`,
        payload: { path: 'a.ts', line: 1, body: 'hi' },
      }),
    );
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('a whitespace-only body → 400 validation_error before any lookup or host call (AC-14)', async () => {
    const { prComments, calls } = countingComments();
    t = await buildHermeticGoogleApp({ overrides: { prComments } });
    const member = t.principals.session('member');
    const res = await t.app.inject(
      asSession(member, {
        method: 'POST',
        url: `/pulls/${TEST_UUID}/comments`,
        payload: { path: 'a.ts', line: 1, body: '   \n\t ' },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(calls).toEqual([]);
  });
});
