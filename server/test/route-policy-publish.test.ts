/**
 * AC-40 — ONE permission-matrix row gates publishing, and the client's
 * `viewer_can_publish` is derived from that same row (plan T10, Q6). Hermetic
 * google mode: fake principals, the real `PublishService` over an in-memory
 * store and the recording `MockGitLabClient` (every "0 GitLab requests"
 * assertion reads `host.calls`).
 *
 * "Flip the row to admin" is simulated by wrapping `lookupPolicy` (the table
 * itself is frozen): the guard AND the publish routes read the row through it,
 * so the flip must restrict both — that is exactly the AC-40 property.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { HostRepoRef } from '@devdigest/shared';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { ROUTE_POLICY, roleSatisfies } from '../src/platform/auth/route-policy.js';
import { PublishService } from '../src/modules/publish/service.js';
import type {
  CreatePublicationInput,
  PublicationRecord,
  PublishReviewContext,
  PublishStore,
} from '../src/modules/publish/ports.js';
import {
  anonymous,
  asSession,
  asToken,
  buildHermeticGoogleApp,
  FAKE_WORKSPACE_ID,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

const PUBLISH_KEY = 'POST /reviews/:id/publications';
const flip = vi.hoisted(() => ({ adminOnly: false }));

vi.mock('../src/platform/auth/route-policy.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/platform/auth/route-policy.js')>();
  return {
    ...mod,
    lookupPolicy: (method: string, url: string) => {
      const found = mod.lookupPolicy(method, url);
      return flip.adminOnly && found.key === PUBLISH_KEY
        ? { ...found, policy: { ...found.policy, access: 'admin' as const } }
        : found;
    },
  };
});

const REVIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const F1 = '00000000-0000-4000-8000-000000000001';
const HEAD = 'f00dbabe5';
const IID = 5;

const CTX: PublishReviewContext = {
  review: { id: REVIEW, workspaceId: FAKE_WORKSPACE_ID, prId: PR, headSha: HEAD },
  pr: { id: PR, number: IID, status: 'open', headSha: HEAD, detailHeadSha: HEAD },
  repo: {
    provider: 'gitlab',
    ref: { provider: 'gitlab', host: 'gitlab.com', owner: 'g', name: 'p', fullName: 'g/p' } as unknown as HostRepoRef,
    webUrl: 'https://gitlab.com/g/p',
  },
  findings: [
    {
      id: F1,
      severity: 'WARNING',
      category: 'bug',
      title: 'A finding',
      rationale: 'Because.',
      suggestion: null,
      kind: 'finding',
      evidence: null,
      file: 'src/a.ts',
      start_line: 2,
      end_line: 2,
      dismissed_at: null,
    },
  ],
  files: [
    {
      path: 'src/a.ts',
      patch: '@@ -1,3 +1,4 @@\n line1\n+added2\n line3\n line4',
      previousPath: null,
      patchOmitted: null,
      changeType: 'modified',
    },
  ],
};

function record(input: CreatePublicationInput): PublicationRecord {
  const now = new Date('2026-10-21T12:00:00Z');
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId: input.workspaceId,
    reviewId: input.reviewId,
    prId: input.prId,
    createdBy: null,
    status: 'in_progress',
    code: null,
    message: null,
    requested: input.items.length,
    drafted: 0,
    published: 0,
    failed: 0,
    generalNotes: 0,
    applicableSuggestions: 0,
    otherDraftsPublished: 0,
    hasSummary: input.hasSummary,
    applySuggestions: input.applySuggestions,
    diffHeadSha: null,
    deprecated: false,
    deprecationReason: null,
    reviewedVersionFound: null,
    positionFallbacks: 0,
    bulkPublishSentAt: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    items: [],
  };
}

describe('publish route policy (AC-40, google mode, hermetic)', () => {
  let t: HermeticGoogleApp;
  const host = new MockGitLabClient({ diffRefs: { [IID]: { headSha: HEAD } } });
  let created = 0;
  let started = 0;

  beforeAll(async () => {
    const store: Partial<PublishStore> = {
      loadReviewContext: async (ws, id) => (ws === FAKE_WORKSPACE_ID && id === REVIEW ? CTX : null),
      findingStates: async () => [],
      inProgressForPr: async () => null,
      createPublication: async (input) => (created++, record(input)),
      setStartDecision: async () => undefined,
      deletePublication: async () => undefined,
    };
    const publishService = new PublishService({
      store: store as PublishStore,
      gitlab: { resolve: async () => ({ host, serviceAccount: 'devdigest-bot' }) },
      tokenHealth: async () => 'ok',
      actorName: async () => null,
      footerEnabled: true,
      runner: { start: () => void started++ },
      reconciler: { trigger: () => undefined },
      clock: { now: () => new Date('2026-10-21T12:00:00Z') },
    });
    t = await buildHermeticGoogleApp({ overrides: { publishService } });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    flip.adminOnly = false;
    host.calls = [];
    created = 0;
    started = 0;
  });

  const post = { method: 'POST' as const, url: `/reviews/${REVIEW}/publications`, payload: { finding_ids: [F1] } };
  const preview = { method: 'GET' as const, url: `/reviews/${REVIEW}/publish-preview` };

  it('the matrix has exactly one publish row, at member, tokens allowed, no route audit; reads are member', () => {
    expect(ROUTE_POLICY[PUBLISH_KEY]).toEqual({ access: 'member' });
    expect(Object.keys(ROUTE_POLICY).filter((k) => k.startsWith('POST ') && k.includes('publication'))).toEqual([
      PUBLISH_KEY,
    ]);
    for (const key of [
      'GET /reviews/:id/publish-preview',
      'GET /reviews/:id/publish-other-drafts',
      'GET /reviews/:id/publish-plan',
      'GET /reviews/:id/publications',
      'GET /publications/:id',
    ]) {
      expect(ROUTE_POLICY[key], key).toEqual({ access: 'member' });
    }
  });

  it('roleSatisfies mirrors the guard (Admins pass member rows; Members fail admin rows)', () => {
    expect(roleSatisfies('member', 'member')).toBe(true);
    expect(roleSatisfies('admin', 'member')).toBe(true);
    expect(roleSatisfies('member', 'admin')).toBe(false);
    expect(roleSatisfies('admin', 'admin')).toBe(true);
    expect(roleSatisfies('member', 'public')).toBe(true);
  });

  it('at member: a Member session and a Member API token may publish, and the preview says so', async () => {
    const session = t.principals.session('member');
    const res = await t.app.inject(asSession(session, post));
    expect(res.statusCode).toBe(202);
    const viaToken = await t.app.inject(asToken(t.principals.token('member'), post));
    expect(viaToken.statusCode).toBe(202);
    expect(started).toBe(2);

    const pv = await t.app.inject(asSession(session, preview));
    expect(pv.statusCode).toBe(200);
    expect(pv.json().viewer_can_publish).toBe(true);
  });

  it('flipped to admin: a Member POST → 403 with 0 GitLab requests, and the Member preview hides the button', async () => {
    flip.adminOnly = true;
    const member = t.principals.session('member');
    const res = await t.app.inject(asSession(member, post));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_role');
    expect(host.calls).toEqual([]);
    expect(created).toBe(0);
    expect(started).toBe(0);

    const pv = await t.app.inject(asSession(member, preview));
    expect(pv.statusCode).toBe(200);
    expect(pv.json().viewer_can_publish).toBe(false);

    // The same flip still lets an Admin through (server) and shows the button (client).
    const admin = t.principals.session('admin');
    expect((await t.app.inject(asSession(admin, preview))).json().viewer_can_publish).toBe(true);
    expect((await t.app.inject(asSession(admin, post))).statusCode).toBe(202);
  });

  it('the publish plan is a member read: a Member session gets 200', async () => {
    const res = await t.app.inject(
      asSession(t.principals.session('member'), { method: 'GET', url: `/reviews/${REVIEW}/publish-plan?finding_ids=${F1}` }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ plan_available: true });
  });

  it('unauthenticated → 401 on every publish route with 0 GitLab requests', async () => {
    for (const req of [
      post,
      preview,
      { method: 'GET' as const, url: `/reviews/${REVIEW}/publish-other-drafts` },
      { method: 'GET' as const, url: `/reviews/${REVIEW}/publish-plan?finding_ids=${F1}` },
      { method: 'GET' as const, url: `/reviews/${REVIEW}/publications` },
      { method: 'GET' as const, url: `/publications/${REVIEW}` },
    ]) {
      const res = await t.app.inject(anonymous(req));
      expect(res.statusCode, req.url).toBe(401);
      expect(res.json().error.code).toBe('unauthenticated');
    }
    expect(host.calls).toEqual([]);
    expect(created).toBe(0);
  });
});
