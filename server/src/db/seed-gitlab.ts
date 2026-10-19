import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * GitLab demo fixture (spec 2026-10-16-gitlab-merge-requests, plan T16).
 *
 * Opt-in: `seed()` calls this only when `SEED_GITLAB_FIXTURE=1`, and only AFTER
 * the GitHub demo repo exists — e2e flows 02/04/05 follow the home redirect to
 * the *first* repo (ordered by `created_at`), so the GitLab repo must be newer.
 * The default `pnpm db:seed` output is unchanged.
 *
 * Seeds repo `space-profit/platform/crm-frontend` on gitlab.com (owner = the full
 * namespace path, name = last segment) with two MRs:
 *   - !5 — draft, stats known, detail fetched at head (`detail_head_sha = head_sha`);
 *     files: one renamed, one with the diff omitted as too large, one normal; 2 commits.
 *   - !6 — list-only row whose host payload carried no diff stats (`stats_known=false`).
 *
 * All fixture writes run in ONE transaction: a failure part-way (e.g. after the
 * repo + MR !5 but before its files) rolls everything back, so re-running the
 * seed repairs it instead of leaving an MR that the guard-by-SELECT would skip
 * forever with no files/commits.
 *
 * Insert-only per row (same guard-by-SELECT idempotency as `seed()`); the one
 * exception is `last_synced_at`, refreshed to now() on every run so the fixture
 * list reads as fresh and no sync is attempted against gitlab.com offline.
 * Deterministic — no host calls.
 */

export const GITLAB_FIXTURE_FULL_NAME = 'space-profit/platform/crm-frontend';
const GITLAB_HOST = 'gitlab.com';

const MR5_HEAD_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const MR6_HEAD_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912345678';

const LEADS_API_PATCH = `@@ -1,8 +1,14 @@
 import { http } from './http';
+import type { LeadFilter } from '../types/lead';

-export async function listLeads() {
-  return http.get('/leads');
+export async function listLeads(filter: LeadFilter = {}) {
+  const params = new URLSearchParams();
+  if (filter.status) params.set('status', filter.status);
+  if (filter.ownerId) params.set('owner_id', filter.ownerId);
+  const query = params.toString();
+  return http.get(query ? \`/leads?\${query}\` : '/leads');
 }

 export async function getLead(id: string) {
   return http.get(\`/leads/\${id}\`);
 }
`;

const LEAD_CARD_PATCH = `@@ -1,6 +1,6 @@
 <script setup lang="ts">
-defineProps<{ contact: { name: string } }>();
+defineProps<{ lead: { name: string } }>();
 </script>

 <template>
-  <div class="card">{{ contact.name }}</div>
+  <div class="card">{{ lead.name }}</div>
 </template>
`;

export async function seedGitlabFixture(
  db: Db,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<{ repoId: string }> {
  return db.transaction(async (tx) => writeFixture(tx, { workspaceId, userId }));
}

/** Transaction handle (same query API as `Db`). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function writeFixture(
  db: Tx,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<{ repoId: string }> {
  // ---- repo (identity = workspace + provider + host + full_name) ----
  let [repo] = await db
    .select()
    .from(t.repos)
    .where(
      and(
        eq(t.repos.workspaceId, workspaceId),
        eq(t.repos.provider, 'gitlab'),
        eq(t.repos.host, GITLAB_HOST),
        eq(t.repos.fullName, GITLAB_FIXTURE_FULL_NAME),
      ),
    );
  if (!repo) {
    [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'space-profit/platform',
        name: 'crm-frontend',
        fullName: GITLAB_FIXTURE_FULL_NAME,
        provider: 'gitlab',
        host: GITLAB_HOST,
        defaultBranch: 'main',
        clonePath: null,
        createdBy: userId,
      })
      .returning();
  }
  const repoId = repo!.id;
  const syncedAt = new Date();
  await db
    .update(t.repos)
    .set({ lastSyncedAt: syncedAt, lastAttemptAt: syncedAt, lastSyncError: null })
    .where(eq(t.repos.id, repoId));

  // ---- MR !5 — draft, full detail at head ----
  const [mr5] = await db
    .select({ id: t.pullRequests.id })
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 5)));
  if (!mr5) {
    const files: (Omit<typeof t.prFiles.$inferInsert, 'prId'> & { additions: number; deletions: number })[] = [
      {
        path: 'src/api/leads.ts',
        additions: 7,
        deletions: 2,
        patch: LEADS_API_PATCH,
        changeType: 'modified',
      },
      {
        path: 'src/components/LeadCard.vue',
        previousPath: 'src/components/ContactCard.vue',
        additions: 2,
        deletions: 2,
        patch: LEAD_CARD_PATCH,
        changeType: 'renamed',
      },
      {
        path: 'package-lock.json',
        additions: 1840,
        deletions: 912,
        patch: null,
        patchOmitted: 'too_large',
        changeType: 'modified',
      },
    ];
    const [row] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 5,
        title: 'Draft: Lead filters on the CRM list view',
        author: 'olena.shevchenko',
        branch: 'feat/lead-filters',
        base: 'main',
        headSha: MR5_HEAD_SHA,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        filesCount: files.length,
        status: 'needs_review',
        body: 'Adds status/owner filters to the leads list and renames ContactCard → LeadCard.',
        openedAt: new Date('2026-10-10T09:00:00.000Z'),
        updatedAt: new Date('2026-10-14T15:30:00.000Z'),
        isDraft: true,
        statsKnown: true,
        detailHeadSha: MR5_HEAD_SHA,
      })
      .returning({ id: t.pullRequests.id });
    const prId = row!.id;
    await db.insert(t.prFiles).values(files.map((f) => ({ ...f, prId })));
    await db.insert(t.prCommits).values([
      {
        prId,
        sha: '4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a291',
        message: 'Rename ContactCard to LeadCard',
        author: 'olena.shevchenko',
        committedAt: new Date('2026-10-10T09:00:00.000Z'),
      },
      {
        prId,
        sha: MR5_HEAD_SHA,
        message: 'Add status and owner filters to listLeads',
        author: 'olena.shevchenko',
        committedAt: new Date('2026-10-14T15:30:00.000Z'),
      },
    ]);
  }

  // ---- MR !6 — list-only, host payload carried no diff stats ----
  const [mr6] = await db
    .select({ id: t.pullRequests.id })
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 6)));
  if (!mr6) {
    await db.insert(t.pullRequests).values({
      workspaceId,
      repoId,
      number: 6,
      title: 'Bump vite to 6.x',
      author: 'renovate-bot',
      branch: 'renovate/vite-6.x',
      base: 'main',
      headSha: MR6_HEAD_SHA,
      additions: 0,
      deletions: 0,
      filesCount: 0,
      status: 'needs_review',
      body: 'Updates vite from 5.4 to 6.0.',
      openedAt: new Date('2026-10-15T08:00:00.000Z'),
      updatedAt: new Date('2026-10-15T08:00:00.000Z'),
      isDraft: false,
      statsKnown: false,
      detailHeadSha: null,
    });
  }

  return { repoId };
}
