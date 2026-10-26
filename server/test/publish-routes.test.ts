/**
 * Publish routes — hermetic HTTP wiring (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, AC-2, AC-20, AC-21; plan T10).
 * Local mode (`buildApp` + `MockAuthProvider`, unreachable DB): the real
 * `PublishService` over an in-memory store and the recording `MockGitLabClient`,
 * injected through `ContainerOverrides.publishService`. The background runner
 * is a recorder, so nothing runs after the 202.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OtherDraftsCount,
  PublicationWithDeprecation as Publication,
  PublishPlan,
  PublishPreviewWithDeprecation as PublishPreview,
  type HostRepoRef,
} from '@devdigest/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider, MockGitLabClient } from '../src/adapters/mocks.js';
import { PublishService } from '../src/modules/publish/service.js';
import type { PublishRunInput } from '../src/modules/publish/executor.js';
import type {
  CreatePublicationInput,
  PublicationRecord,
  PublishFindingRow,
  PublishReviewContext,
  PublishStore,
} from '../src/modules/publish/ports.js';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const REVIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_REVIEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F1 = '00000000-0000-4000-8000-000000000001';
const HEAD = 'f00dbabe5';
const IID = 5;

const REF = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'group/sub',
  name: 'proj',
  fullName: 'group/sub/proj',
} as unknown as HostRepoRef;

function finding(id: string): PublishFindingRow {
  return {
    id,
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
  };
}

const CTX: PublishReviewContext = {
  review: { id: REVIEW, workspaceId: WS, prId: PR, headSha: HEAD },
  pr: { id: PR, number: IID, status: 'open', headSha: HEAD, detailHeadSha: HEAD },
  repo: { provider: 'gitlab', ref: REF, webUrl: 'https://gitlab.com/group/sub/proj' },
  findings: [finding(F1)],
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

/** In-memory store: only what the service touches on these routes. */
function fakeStore() {
  const records = new Map<string, PublicationRecord>();
  const store: Partial<PublishStore> = {
    loadReviewContext: async (ws, id) => (ws === WS && id === REVIEW ? CTX : null),
    findingStates: async () => [],
    inProgressForPr: async () => null,
    createPublication: async (input: CreatePublicationInput) => {
      const now = new Date('2026-10-21T12:00:00Z');
      const record: PublicationRecord = {
        id: PUB,
        workspaceId: input.workspaceId,
        reviewId: input.reviewId,
        prId: input.prId,
        createdBy: input.createdBy ? { id: input.createdBy, name: 'You' } : null,
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
        items: input.items.map((i) => ({
          findingId: i.findingId,
          position: i.position,
          state: 'pending',
          code: null,
          anchorKind: i.anchorKind,
          draftId: null,
          discussionId: null,
          noteId: null,
          url: null,
          publishedAt: null,
        })),
      };
      records.set(record.id, record);
      return record;
    },
    setStartDecision: async () => undefined,
    deletePublication: async (id) => void records.delete(id),
    getPublication: async (ws, id) => (ws === WS ? (records.get(id) ?? null) : null),
    listForReview: async (ws, reviewId) =>
      ws === WS ? [...records.values()].filter((r) => r.reviewId === reviewId) : [],
  };
  return { store: store as PublishStore, records };
}

interface Harness {
  app: FastifyInstance;
  host: MockGitLabClient;
  started: PublishRunInput[];
}

async function harness(): Promise<Harness> {
  const host = new MockGitLabClient({ diffRefs: { [IID]: { headSha: HEAD } } });
  const started: PublishRunInput[] = [];
  const { store } = fakeStore();
  const publishService = new PublishService({
    store,
    gitlab: { resolve: async () => ({ host, serviceAccount: 'devdigest-bot' }) },
    tokenHealth: async () => 'ok',
    actorName: async () => ({ name: 'You', email: 'you@local' }),
    footerEnabled: false,
    runner: { start: (input) => void started.push(input) },
    reconciler: { trigger: () => undefined },
    clock: { now: () => new Date('2026-10-21T12:00:00Z') },
  });
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AUTH_MODE: 'local',
    // Nothing listens here: any DB use fails fast instead of touching a dev DB.
    DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
  } as NodeJS.ProcessEnv);
  const app = await buildApp({
    config,
    overrides: {
      auth: new MockAuthProvider({ id: USER, email: 'you@local', name: 'You' }, { id: WS, name: 'default' }),
      publishService,
    },
  });
  await app.ready();
  return { app, host, started };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.app.close();
});

describe('publish routes (hermetic, local mode)', () => {
  it('POST /reviews/:id/publications → 202 with an in-progress Publication; the task is started, not awaited', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/reviews/${REVIEW}/publications`,
      payload: { finding_ids: [F1], summary: 'Looks good overall.' },
    });
    expect(res.statusCode).toBe(202);
    const body = Publication.parse(res.json());
    expect(body).toMatchObject({
      id: PUB,
      review_id: REVIEW,
      pr_id: PR,
      status: 'in_progress',
      requested: 1,
      has_summary: true,
      apply_suggestions: false,
      created_by: { id: USER },
    });
    expect(body.items).toEqual([{ finding_id: F1, state: 'pending', code: null, link: null }]);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ publicationId: PUB, workspaceId: WS, iid: IID, actorUserId: USER });
    // Exactly one read (the diff refs, AC-12) before the 202 — no write.
    expect(h.host.calls.map((c) => c.kind)).toEqual(['diff_refs']);
  });

  it('a review of another workspace → 404 with 0 GitLab requests (POST and reads)', async () => {
    const post = await h.app.inject({
      method: 'POST',
      url: `/reviews/${FOREIGN_REVIEW}/publications`,
      payload: { finding_ids: [F1] },
    });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe('not_found');
    for (const url of [
      `/reviews/${FOREIGN_REVIEW}/publish-preview`,
      `/reviews/${FOREIGN_REVIEW}/publish-other-drafts`,
      `/reviews/${FOREIGN_REVIEW}/publish-plan?finding_ids=${F1}`,
      `/reviews/${FOREIGN_REVIEW}/publications`,
      `/publications/${FOREIGN_REVIEW}`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
    expect(h.host.calls).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it('the body is validated by the service (AC-20 codes), not by a route schema', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/reviews/${REVIEW}/publications`,
      payload: { finding_ids: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('publish_selection_invalid');
    expect(h.host.calls).toEqual([]);
  });

  it('non-uuid :id → 422 at the edge', async () => {
    for (const [method, url] of [
      ['GET', '/reviews/nope/publish-preview'],
      ['POST', '/reviews/nope/publications'],
      ['GET', '/publications/nope'],
    ] as const) {
      const res = await h.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(422);
    }
  });

  it('preview, other-drafts, list and status reads answer their contracts (local Admin may publish)', async () => {
    const preview = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publish-preview` });
    expect(preview.statusCode).toBe(200);
    const parsed = PublishPreview.parse(preview.json());
    expect(parsed).toMatchObject({ review_id: REVIEW, provider: 'gitlab', mr_iid: IID, viewer_can_publish: true });
    expect(h.host.calls).toEqual([]); // AC-2: the preview makes 0 GitLab requests

    const other = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publish-other-drafts` });
    expect(other.statusCode).toBe(200);
    expect(OtherDraftsCount.parse(other.json())).toEqual({ other_drafts: 0 });

    await h.app.inject({ method: 'POST', url: `/reviews/${REVIEW}/publications`, payload: { finding_ids: [F1] } });
    const list = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publications` });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((p: { id: string }) => p.id)).toEqual([PUB]);

    const one = await h.app.inject({ method: 'GET', url: `/publications/${PUB}` });
    expect(one.statusCode).toBe(200);
    const parsedOne = Publication.parse(one.json());
    expect(parsedOne).toMatchObject({ status: 'in_progress', deprecated: false, deprecation_reason: null, position_fallbacks: 0 });
  });

  it('GET /reviews/:id/publish-plan → PublishPlan from GETs only; a malformed selection → 400 publish_selection_invalid (outdated-findings AC-21)', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publish-plan?finding_ids=${F1}` });
    expect(res.statusCode).toBe(200);
    expect(PublishPlan.parse(res.json())).toEqual({
      other_drafts: 0,
      plan_available: true,
      deprecation: null,
      placement: { positioned: 1, general: 0 },
    });
    expect(h.host.calls.map((c) => c.kind).sort()).toEqual(['diff_refs', 'draft_notes']);
    expect(h.host.draftWrites).toEqual([]);

    h.host.calls = [];
    for (const qs of ['', '?finding_ids=nope', `?finding_ids=${F1},${F1}`]) {
      const bad = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publish-plan${qs}` });
      expect(bad.statusCode, qs).toBe(400);
      expect(bad.json().error.code).toBe('publish_selection_invalid');
    }
    expect(h.host.calls).toEqual([]);
  });

  it('a moved head: POST without the flag → 409 review_diff_outdated; with it → 202 deprecated, and the preview serialises `deferred` anchors', async () => {
    h.host.opts.diffRefs = { [IID]: { headSha: 'newhead' } };
    const refused = await h.app.inject({ method: 'POST', url: `/reviews/${REVIEW}/publications`, payload: { finding_ids: [F1] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('review_diff_outdated');
    const ok = await h.app.inject({
      method: 'POST',
      url: `/reviews/${REVIEW}/publications`,
      payload: { finding_ids: [F1], acknowledge_deprecated: true },
    });
    expect(ok.statusCode).toBe(202);
    expect(Publication.parse(ok.json())).toMatchObject({ deprecated: true, deprecation_reason: 'head_moved' });

    CTX.pr.headSha = 'newhead';
    try {
      const pv = await h.app.inject({ method: 'GET', url: `/reviews/${REVIEW}/publish-preview` });
      expect(pv.statusCode).toBe(200);
      const preview = PublishPreview.parse(pv.json());
      expect(preview.deprecation).toEqual({ reason: 'head_moved', reviewed_head_sha: HEAD });
      expect(preview.findings[0]!.anchor.kind).toBe('deferred');
    } finally {
      CTX.pr.headSha = HEAD;
    }
  });
});
