import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeprecationReason,
  PublicationItemState,
  PublicationStatus,
  PublishAnchorKind,
  PublishAnchorKindAll,
} from '@devdigest/shared';
import {
  startPg,
  startEmptyPg,
  dockerAvailable,
  type PgFixture,
  type EmptyPgFixture,
} from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import {
  DEPRECATION_REASONS,
  PUBLICATION_ITEM_STATES,
  PUBLICATION_STATUSES,
  PUBLISH_ANCHOR_KINDS,
  PUBLISH_ANCHOR_KINDS_ALL,
} from '../src/db/schema.js';

/**
 * Migration 0027 — review publications (spec gitlab-publish-findings):
 *   - partial unique `review_publications_pr_in_progress_uq` = the per-PR publish lock (AC-22);
 *   - partial unique `review_publication_items_finding_live_uq` = never drafted/published twice (AC-35);
 *   - status / state / anchor_kind / url CHECKs; review delete cascades;
 *   - `reviews.head_sha` is additive: pre-0027 rows read NULL (AC-1).
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

describe('schema literal lists mirror the contract enums', () => {
  it('keeps the CHECK lists in lockstep with @devdigest/shared', () => {
    expect([...PUBLICATION_STATUSES]).toEqual(PublicationStatus.options);
    expect([...PUBLICATION_ITEM_STATES]).toEqual(PublicationItemState.options);
    expect([...PUBLISH_ANCHOR_KINDS]).toEqual(PublishAnchorKind.options);
    expect([...PUBLISH_ANCHOR_KINDS_ALL]).toEqual(PublishAnchorKindAll.options);
    expect([...DEPRECATION_REASONS]).toEqual(DeprecationReason.options);
  });
});

d('migration 0027 — review publications constraints', () => {
  let pg: PgFixture;
  let sql: postgres.Sql;
  let workspaceId: string;
  let prId: string;
  let reviewId: string;
  let findingA: string;
  let findingB: string;
  let findingC: string;

  beforeAll(async () => {
    pg = await startPg();
    sql = pg.handle.sql;
    ({ workspaceId } = await seed(pg.handle.db));
    const [r] = await sql`
      INSERT INTO repos (workspace_id, owner, name, full_name, provider, host)
      VALUES (${workspaceId}, 'grp', 'pub', 'grp/pub', 'gitlab', 'gitlab.com') RETURNING id`;
    const [p] = await sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${workspaceId}, ${r!.id}, 7, 'mr', 'octo', 'feat', 'main', 'sha7') RETURNING id`;
    prId = p!.id as string;
    reviewId = await insertReview();
    [findingA, findingB, findingC] = await Promise.all([
      insertFinding(reviewId),
      insertFinding(reviewId),
      insertFinding(reviewId),
    ]);
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function insertReview(): Promise<string> {
    const [row] = await sql`
      INSERT INTO reviews (workspace_id, pr_id, kind, score, head_sha)
      VALUES (${workspaceId}, ${prId}, 'review', 80, 'sha7') RETURNING id`;
    return row!.id as string;
  }

  async function insertFinding(rid: string): Promise<string> {
    const [row] = await sql`
      INSERT INTO findings (review_id, file, start_line, end_line, severity, category, title, rationale, confidence)
      VALUES (${rid}, 'a.ts', 1, 2, 'WARNING', 'bug', 't', 'r', 0.9) RETURNING id`;
    return row!.id as string;
  }

  /** Inserts a publication; terminal statuses get `finished_at` so the finished CHECK holds. */
  async function insertPublication(
    status: string,
    opts: { rid?: string; finished?: boolean; url?: string } = {},
  ): Promise<string> {
    const finished = opts.finished ?? ['published', 'partially_published', 'failed'].includes(status);
    const [row] = await sql`
      INSERT INTO review_publications (workspace_id, review_id, pr_id, status, requested, has_summary, finished_at)
      VALUES (${workspaceId}, ${opts.rid ?? reviewId}, ${prId}, ${status}, 3, false, CASE WHEN ${finished}::boolean THEN now() END)
      RETURNING id`;
    return row!.id as string;
  }

  function insertItem(
    publicationId: string,
    findingId: string,
    state: string,
    extra: { anchorKind?: string; url?: string | null } = {},
  ) {
    return sql`
      INSERT INTO review_publication_items (publication_id, finding_id, position, state, anchor_kind, url)
      VALUES (${publicationId}, ${findingId}, 0, ${state}, ${extra.anchorKind ?? 'single_line'}, ${extra.url ?? null})
      RETURNING id`;
  }

  /** Every test cleans its publications so the partial uniques start empty. */
  async function clearPublications() {
    await sql`DELETE FROM review_publications`;
  }

  it('allows at most one in_progress publication per PR (AC-22 lock)', async () => {
    await clearPublications();
    await insertPublication('in_progress');
    await expect(insertPublication('in_progress')).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'review_publications_pr_in_progress_uq',
    });
    // A finished publication of the same PR does not hold the lock.
    await expect(insertPublication('failed')).resolves.toEqual(expect.any(String));
    await expect(insertPublication('unconfirmed')).resolves.toEqual(expect.any(String));
  });

  it('never lets a finding be live in two publications (AC-35)', async () => {
    await clearPublications();
    const p1 = await insertPublication('published');
    const p2 = await insertPublication('partially_published');
    const p3 = await insertPublication('failed');

    await insertItem(p1, findingA, 'published');
    await expect(insertItem(p2, findingA, 'published')).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'review_publication_items_finding_live_uq',
    });

    await insertItem(p1, findingB, 'drafted');
    await expect(insertItem(p2, findingB, 'published')).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'review_publication_items_finding_live_uq',
    });

    // A failed (or rolled-back) row is not live: the finding may be published again.
    await insertItem(p3, findingC, 'failed');
    await expect(insertItem(p2, findingC, 'published')).resolves.toHaveLength(1);
    await insertItem(p1, findingC, 'rolled_back');

    // One row per (publication, finding), whatever the state.
    await expect(insertItem(p3, findingC, 'rolled_back')).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'review_publication_items_publication_finding_uq',
    });
  });

  it('rejects bad status / state / anchor_kind / url and an unfinished terminal publication', async () => {
    await clearPublications();
    await expect(insertPublication('done')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_status_ck',
    });
    await expect(insertPublication('published', { finished: false })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_finished_ck',
    });
    await expect(
      sql`
        INSERT INTO review_publications (workspace_id, review_id, pr_id, requested, has_summary)
        VALUES (${workspaceId}, ${reviewId}, ${prId}, 51, false)`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: 'review_publications_requested_ck' });
    await expect(
      sql`
        INSERT INTO review_publications (workspace_id, review_id, pr_id, requested, published, failed, has_summary)
        VALUES (${workspaceId}, ${reviewId}, ${prId}, 2, 2, 1, false)`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: 'review_publications_totals_ck' });

    const pub = await insertPublication('in_progress');
    await expect(insertItem(pub, findingA, 'sent')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publication_items_state_ck',
    });
    await expect(insertItem(pub, findingA, 'pending', { anchorKind: 'file' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publication_items_anchor_kind_ck',
    });
    await expect(insertItem(pub, findingA, 'failed', { url: 'http://x' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publication_items_url_ck',
    });
    await expect(
      insertItem(pub, findingA, 'failed', { url: 'https://gitlab.com/g/p/-/merge_requests/7#note_1' }),
    ).resolves.toHaveLength(1);
  });

  // Migration 0028 — deprecated publications (spec gitlab-publish-outdated-findings).
  function insertDeprecationRow(cols: {
    deprecated: boolean;
    reason: string | null;
    positionFallbacks?: number;
  }) {
    return sql`
      INSERT INTO review_publications
        (workspace_id, review_id, pr_id, status, requested, has_summary, finished_at,
         deprecated, deprecation_reason, position_fallbacks)
      VALUES (${workspaceId}, ${reviewId}, ${prId}, 'failed', 3, false, now(),
         ${cols.deprecated}, ${cols.reason}, ${cols.positionFallbacks ?? 0})
      RETURNING id`;
  }

  it('ties deprecated to deprecation_reason and bounds the new columns (0028)', async () => {
    await clearPublications();
    await expect(insertDeprecationRow({ deprecated: true, reason: null })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_deprecation_ck',
    });
    await expect(
      insertDeprecationRow({ deprecated: false, reason: 'head_moved' }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_deprecation_ck',
    });
    await expect(
      insertDeprecationRow({ deprecated: true, reason: 'stale' }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_deprecation_reason_ck',
    });
    await expect(
      insertDeprecationRow({ deprecated: false, reason: null, positionFallbacks: -1 }),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publications_position_fallbacks_ck',
    });
    await expect(insertDeprecationRow({ deprecated: true, reason: 'head_unknown' })).resolves.toHaveLength(1);
    await expect(insertDeprecationRow({ deprecated: true, reason: 'head_moved' })).resolves.toHaveLength(1);
  });

  it('defaults the 0028 columns for a row inserted without them', async () => {
    await clearPublications();
    const pub = await insertPublication('in_progress');
    const [row] = await sql`
      SELECT deprecated, deprecation_reason, reviewed_version_found, position_fallbacks
      FROM review_publications WHERE id = ${pub}`;
    expect(row).toEqual({
      deprecated: false,
      deprecation_reason: null,
      reviewed_version_found: null,
      position_fallbacks: 0,
    });
  });

  it("accepts the 'deferred' anchor kind and still rejects unknown ones (0028)", async () => {
    await clearPublications();
    const pub = await insertPublication('in_progress');
    await expect(insertItem(pub, findingA, 'pending', { anchorKind: 'deferred' })).resolves.toHaveLength(1);
    await expect(insertItem(pub, findingB, 'pending', { anchorKind: 'bogus' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: 'review_publication_items_anchor_kind_ck',
    });
  });

  it('cascades a review delete to its publications and items', async () => {
    await clearPublications();
    const rid = await insertReview();
    const fid = await insertFinding(rid);
    const pub = await insertPublication('published', { rid });
    await insertItem(pub, fid, 'published');

    await sql`DELETE FROM reviews WHERE id = ${rid}`;

    const pubs = await sql`SELECT id FROM review_publications WHERE id = ${pub}`;
    const items = await sql`SELECT id FROM review_publication_items WHERE publication_id = ${pub}`;
    expect(pubs).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-1 additive column: a review row written before 0027 reads head_sha = NULL.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

interface Journal {
  entries: { idx: number; tag: string }[];
  [k: string]: unknown;
}

function migrationsBefore(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devdigest-mig-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const cut = journal.entries.findIndex((e) => e.tag.startsWith(prefix));
  if (cut < 0) throw new Error(`migration ${prefix} not found in journal`);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

d('migration 0027 — applies over pre-existing reviews', () => {
  let container: EmptyPgFixture;
  let sql: postgres.Sql;
  let oldDir: string;

  beforeAll(async () => {
    container = await startEmptyPg();
    sql = postgres(container.url, { max: 1, onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    oldDir = migrationsBefore('0027_');
    await migrate(drizzle(sql), { migrationsFolder: oldDir });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  it('keeps old review rows with head_sha = NULL', async () => {
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Old') RETURNING id`;
    const [repo] = await sql`
      INSERT INTO repos (workspace_id, owner, name, full_name) VALUES (${ws!.id}, 'o', 'r', 'o/r') RETURNING id`;
    const [pr] = await sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${ws!.id}, ${repo!.id}, 1, 'pr', 'octo', 'feat', 'main', 'sha') RETURNING id`;
    const [review] = await sql`
      INSERT INTO reviews (workspace_id, pr_id, kind, score) VALUES (${ws!.id}, ${pr!.id}, 'review', 70) RETURNING id`;

    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

    const [row] = await sql`SELECT head_sha FROM reviews WHERE id = ${review!.id}`;
    expect(row).toEqual({ head_sha: null });
  });
});

// ---------------------------------------------------------------------------
// Migration 0028 is additive: a publication written before it reads the defaults.
// ---------------------------------------------------------------------------

d('migration 0028 — applies over pre-existing publications', () => {
  let container: EmptyPgFixture;
  let sql: postgres.Sql;
  let oldDir: string;

  beforeAll(async () => {
    container = await startEmptyPg();
    sql = postgres(container.url, { max: 1, onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    oldDir = migrationsBefore('0028_');
    await migrate(drizzle(sql), { migrationsFolder: oldDir });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
  });

  it('keeps old publication rows as not deprecated with zero fallbacks', async () => {
    const [ws] = await sql`INSERT INTO workspaces (name) VALUES ('Old') RETURNING id`;
    const [repo] = await sql`
      INSERT INTO repos (workspace_id, owner, name, full_name) VALUES (${ws!.id}, 'o', 'r', 'o/r') RETURNING id`;
    const [pr] = await sql`
      INSERT INTO pull_requests (workspace_id, repo_id, number, title, author, branch, base, head_sha)
      VALUES (${ws!.id}, ${repo!.id}, 1, 'pr', 'octo', 'feat', 'main', 'sha') RETURNING id`;
    const [review] = await sql`
      INSERT INTO reviews (workspace_id, pr_id, kind, score, head_sha)
      VALUES (${ws!.id}, ${pr!.id}, 'review', 70, 'sha') RETURNING id`;
    const [pub] = await sql`
      INSERT INTO review_publications (workspace_id, review_id, pr_id, status, requested, has_summary, finished_at)
      VALUES (${ws!.id}, ${review!.id}, ${pr!.id}, 'published', 1, false, now()) RETURNING id`;

    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

    const [row] = await sql`
      SELECT deprecated, deprecation_reason, reviewed_version_found, position_fallbacks
      FROM review_publications WHERE id = ${pub!.id}`;
    expect(row).toEqual({
      deprecated: false,
      deprecation_reason: null,
      reviewed_version_found: null,
      position_fallbacks: 0,
    });
  });
});
