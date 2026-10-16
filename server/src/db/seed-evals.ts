import type { EvalExpectedOutput, EvalPrMeta } from '@devdigest/shared';

/**
 * L06 — the seeded eval set (spec `specs/06-eval-pipeline.md` §11).
 *
 * DATA ONLY, ON PURPOSE. This module performs no DB write and imports nothing
 * from `db/`, `adapters/` or `fastify`: `SEED_EVAL_CASES` is a plain, importable
 * array so `pnpm verify:l06` can assert the §11 invariants over it with **no
 * Postgres, no network and no API key** (AC-37, AC-39). `seed.ts` is the only
 * consumer that writes it, with a `(workspace_id, owner_id, name)` select-guard
 * (there is no unique constraint to `onConflictDoNothing` against).
 *
 * Ten cases, all owned by the seeded `Security Reviewer`, composed per §11:
 *
 *  - **6 × `must_find`** — a real defect on a real ADDED line;
 *  - **4 × `must_not_flag`** — including `clean-refactor-no-flags`, a genuinely
 *    clean diff.
 *
 * Both kinds are mandatory. Precision is `1 − (Σ noise_findings / Σ findings_total)`
 * and `noise_findings` can only be produced by a `must_not_flag` expectation
 * (§4.6), so a set of nothing but `must_find` cases pins precision at 1.0 and it
 * can never move — the harness would then be unable to detect a new false
 * positive, which is half of what it exists for.
 *
 * ---------------------------------------------------------------------------
 * Invariants every case here must satisfy (§11; mechanically asserted by
 * `verify:l06`, AC-40 — do NOT hand-verify these when editing):
 * ---------------------------------------------------------------------------
 *  1. `expectedOutput` parses as `EvalExpectedOutput` (C3);
 *  2. `parseUnifiedDiff(inputDiff).files.length >= 1`. The parser NEVER throws —
 *     a malformed diff silently yields `files: []` (`adapters/git/diff-parser.ts:76`),
 *     which would turn the case into a permanently-erroring `empty_diff` row;
 *  3. every `must_find` expectation's `[start_line, end_line]` intersects a hunk
 *     of ITS OWN diff. The grounding gate indexes new-side line numbers from the
 *     `@@` headers and drops any finding outside them — an expectation that
 *     misses its own hunks makes the correct answer ungroundable and pins that
 *     case's recall at 0 forever;
 *  4. names are unique within the owner.
 *
 * So: whenever a diff below is edited, the `@@ -a,b +c,d @@` counts and every
 * expectation line number move with it. `b` = context + deleted lines, `d` =
 * context + added lines; new-side numbering starts at `c` and advances on
 * context and added lines only.
 *
 * ---------------------------------------------------------------------------
 * On the secret-looking strings
 * ---------------------------------------------------------------------------
 * The `must_find` fixtures deliberately contain credential-shaped text — that is
 * the defect the Security Reviewer is being measured on. Every one of them is
 * SYNTHETIC and deliberately authored so that no real secret-scanner rule
 * matches: the vendor prefixes are followed by an underscore-broken
 * `FIXTURE_NOT_A_REAL_*` body rather than the contiguous alphanumeric run those
 * rules require, and the Supabase case leaks a *variable name*, never a token.
 * Keep it that way when editing — a fixture must never trip CI's secret scan.
 *
 * `source_finding_id` is `null` for every seeded case: they have no real
 * accept/dismiss provenance, and the case editor renders that honestly.
 */

/**
 * One seeded case. Owner is resolved by AGENT NAME at seed time (agent ids are
 * generated), then written as `owner_kind: 'agent'` + `owner_id`.
 */
export interface SeedEvalCase {
  /** Unique within `(workspace_id, owner_id)`; the select-guard key. */
  name: string;
  /** Resolved against the seeded agents by name; the case is skipped if absent. */
  ownerAgentName: string;
  notes: string;
  /** Self-contained unified diff — the pinned input, never re-derived (§5.2). */
  inputDiff: string;
  /** `eval_cases.input_meta`; only `title` and `body` reach the model (§5.1). */
  inputMeta: EvalPrMeta;
  /** `eval_cases.expected_output` (C3, D2: one case, one kind). */
  expectedOutput: EvalExpectedOutput;
}

// ===========================================================================
// must_find — a real defect on a real added line
// ===========================================================================

/**
 * Trim the single trailing newline a multi-line template literal ends with, so a
 * seeded diff has exactly the shape a real one does: `diffFromPrFiles` builds its
 * diff with `parts.join('\n')` (`modules/reviews/diff-loader.ts:44`), i.e. no
 * trailing newline. `parseUnifiedDiff` treats the empty string a trailing newline
 * produces as a CONTEXT line and advances its new-side cursor over it
 * (`adapters/git/diff-parser.ts:70-74`), which would add one phantom line to the
 * grounding index past the end of the last hunk.
 */
const unified = (raw: string): string => raw.replace(/\n$/, '');

/** New-side lines 8..16; the two hardcoded keys land on 12 and 13. */
const STRIPE_KEY_LEAK_DIFF = unified(`diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -8,6 +8,9 @@ export interface AppConfig {
   port: number;
   databaseUrl: string;
 }
+// TODO: move to the secret manager before launch
+export const STRIPE_SECRET_KEY = 'sk_live_FIXTURE_NOT_A_REAL_KEY_0000';
+export const STRIPE_WEBHOOK_SECRET = 'whsec_FIXTURE_NOT_A_REAL_SECRET';
 export function loadConfig(): AppConfig {
   return {
     port: Number(process.env.PORT ?? 3000),
`);

/** New-side lines 14..23; the caller-controlled fetch lands on 17. */
const SSRF_WEBHOOK_DIFF = unified(`diff --git a/src/api/public/webhooks.ts b/src/api/public/webhooks.ts
--- a/src/api/public/webhooks.ts
+++ b/src/api/public/webhooks.ts
@@ -14,4 +14,10 @@ import { logger } from '../../logger';
 export async function forwardWebhook(req: Request, res: Response) {
   const { callbackUrl, payload } = req.body;
   logger.info({ callbackUrl }, 'forwarding webhook');
+  const upstream = await fetch(callbackUrl, {
+    method: 'POST',
+    headers: { 'content-type': 'application/json' },
+    body: JSON.stringify(payload),
+  });
+  res.status(upstream.status).json(await upstream.json());
 }
`);

/** New-side lines 31..42; the header-less 429 branch spans 34..39. */
const MISSING_RETRY_AFTER_DIFF = unified(`diff --git a/src/middleware/ratelimit.ts b/src/middleware/ratelimit.ts
--- a/src/middleware/ratelimit.ts
+++ b/src/middleware/ratelimit.ts
@@ -31,6 +31,12 @@ export function rateLimit(opts: RateLimitOptions) {
   return async function handler(req: Request, res: Response, next: NextFunction) {
     const key = clientKey(req);
     const hit = await bucket.take(key, opts.costPerRequest);
+    if (!hit.allowed) {
+      // Reject over-budget callers. No Retry-After header is sent, so clients
+      // cannot tell when to try again and will hot-loop against the limiter.
+      res.status(429).json({ error: 'rate_limited' });
+      return;
+    }
     next();
   };
 }
`);

/** New-side lines 1..8; the service-role key reaches the browser on line 6. */
const SERVICE_ROLE_IN_CLIENT_DIFF = unified(`diff --git a/web/src/lib/supabase.ts b/web/src/lib/supabase.ts
--- a/web/src/lib/supabase.ts
+++ b/web/src/lib/supabase.ts
@@ -1,6 +1,8 @@
 'use client';
 import { createClient } from '@supabase/supabase-js';
-export const supabase = createClient(
-  process.env.NEXT_PUBLIC_SUPABASE_URL!,
-  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
-);
+// The anon key kept tripping RLS, so read from the browser with service role.
+export const supabase = createClient(
+  process.env.NEXT_PUBLIC_SUPABASE_URL!,
+  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
+  { auth: { persistSession: false } },
+);
`);

/** New-side lines 40..49; the concatenated SQL spans 43..47. */
const SQL_INJECTION_DIFF = unified(`diff --git a/src/api/users.ts b/src/api/users.ts
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -40,5 +40,10 @@ import { db } from '../db';
 export async function searchUsers(req: Request, res: Response) {
   const term = String(req.query.q ?? '');
   const limit = Number(req.query.limit ?? 25);
+  const rows = await db.raw(
+    "SELECT id, email, name FROM users WHERE email LIKE '%" +
+      term +
+      "%' ORDER BY created_at DESC LIMIT " + limit,
+  );
   res.json({ rows });
 }
`);

/** New-side lines 22..30; the unsanitized join lands on 25. */
const PATH_TRAVERSAL_DIFF = unified(`diff --git a/src/api/files.ts b/src/api/files.ts
--- a/src/api/files.ts
+++ b/src/api/files.ts
@@ -22,3 +22,9 @@ const UPLOAD_DIR = '/var/app/uploads';
 export function downloadFile(req: Request, res: Response) {
   const name = String(req.query.name ?? '');
+  // Callers pass the stored filename; join it onto the upload directory.
+  const abs = path.join(UPLOAD_DIR, name);
+  if (!fs.existsSync(abs)) {
+    return res.status(404).json({ error: 'not_found' });
+  }
+  res.sendFile(abs);
 }
`);

// ===========================================================================
// must_not_flag — locations the agent must stay silent about
// ===========================================================================

/**
 * A genuinely clean diff: one helper extracted, one function renamed, behaviour
 * byte-identical. New-side lines 3..11 — the whole changed region is off limits.
 */
const CLEAN_REFACTOR_DIFF = unified(`diff --git a/src/utils/format.ts b/src/utils/format.ts
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -3,6 +3,9 @@ const MS_PER_SECOND = 1000;
 const MS_PER_MINUTE = 60 * MS_PER_SECOND;
-export function fmt(ms: number): string {
-  if (ms < MS_PER_SECOND) return ms + 'ms';
-  if (ms < MS_PER_MINUTE) return (ms / MS_PER_SECOND).toFixed(1) + 's';
-  return Math.round(ms / MS_PER_MINUTE) + 'm';
-}
+function seconds(ms: number): string {
+  return (ms / MS_PER_SECOND).toFixed(1) + 's';
+}
+export function formatDuration(ms: number): string {
+  if (ms < MS_PER_SECOND) return ms + 'ms';
+  if (ms < MS_PER_MINUTE) return seconds(ms);
+  return Math.round(ms / MS_PER_MINUTE) + 'm';
+}
`);

/** New-side lines 5..15; the throwaway spec secret spans 6..14. */
const TEST_FIXTURE_TOKEN_DIFF = unified(`diff --git a/src/api/__tests__/auth.test.ts b/src/api/__tests__/auth.test.ts
--- a/src/api/__tests__/auth.test.ts
+++ b/src/api/__tests__/auth.test.ts
@@ -5,2 +5,11 @@ import { signToken, verifyToken } from '../auth';
 describe('auth tokens', () => {
+  // Deterministic throwaway secret: this spec never talks to a real service.
+  const TEST_SECRET = 'test-secret-not-used-outside-this-spec';
+  it('round-trips a signed token', () => {
+    const token = signToken({ sub: 'user-1' }, TEST_SECRET);
+    expect(verifyToken(token, TEST_SECRET).sub).toBe('user-1');
+  });
+  it('rejects a token signed with another secret', () => {
+    expect(() => verifyToken(signToken({ sub: 'x' }, 'other'), TEST_SECRET)).toThrow();
+  });
 });
`);

/** New-side lines 1..8; the empty placeholder keys span 4..7. */
const ENV_EXAMPLE_DIFF = unified(`diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@ -1,4 +1,8 @@
 # Copy to .env and fill in real values. Never commit .env.
 DATABASE_URL=postgres://app_user:__FILL_ME_IN__@localhost:5432/app
 PORT=3000
+# Stripe - obtain from the dashboard, then store in the secret manager.
+STRIPE_SECRET_KEY=
+STRIPE_WEBHOOK_SECRET=
+OPENROUTER_API_KEY=
 NODE_ENV=development
`);

/**
 * The diff REPLACES an unsafe `jwt.decode` with a fully-checked `jwt.verify`
 * (explicit algorithm allow-list, issuer, audience, clock tolerance, subject).
 * It is the fix, not the bug. New-side lines 10..22.
 */
const JWT_VERIFY_DIFF = unified(`diff --git a/src/auth/verify.ts b/src/auth/verify.ts
--- a/src/auth/verify.ts
+++ b/src/auth/verify.ts
@@ -10,4 +10,13 @@ import { config } from '../config';
 export function verifyAccessToken(token: string): AccessClaims {
-  const claims = jwt.decode(token) as AccessClaims;
-  return claims;
+  // Signature, algorithm, issuer, audience and expiry are all enforced here.
+  const claims = jwt.verify(token, config.jwtPublicKey, {
+    algorithms: ['RS256'],
+    issuer: config.jwtIssuer,
+    audience: config.jwtAudience,
+    clockTolerance: 5,
+  }) as AccessClaims;
+  if (!claims.sub) {
+    throw new UnauthorizedError('missing subject');
+  }
+  return claims;
 }
`);

const SECURITY_REVIEWER = 'Security Reviewer';

/**
 * The seeded set. Order is display order in the agent's Evals tab; the design's
 * five names come first.
 */
export const SEED_EVAL_CASES: SeedEvalCase[] = [
  {
    name: 'stripe-key-leak',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'Live Stripe credentials committed to src/config.ts. The canonical CRITICAL secret leak: if the agent misses this one, nothing else about it matters.',
    inputDiff: STRIPE_KEY_LEAK_DIFF,
    inputMeta: {
      title: 'Wire up Stripe billing',
      body: 'Adds the Stripe client so the billing endpoints can charge cards. Keys are inline for now, we will move them later.',
      number: 611,
      author: 'marisa.koch',
      base: 'main',
      branch: 'feat/stripe-billing',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'src/config.ts',
          start_line: 12,
          end_line: 13,
          title: 'Hardcoded Stripe secret key committed to the repository',
          severity: 'CRITICAL',
          category: 'security',
        },
      ],
    },
  },
  {
    name: 'ssrf-webhook',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'Server-side request forgery: the public webhook forwarder fetches whatever URL the caller puts in the request body, with no scheme or host allow-list.',
    inputDiff: SSRF_WEBHOOK_DIFF,
    inputMeta: {
      title: 'Forward webhook payloads to customer callback URLs',
      body: 'Customers asked to receive webhook payloads on their own endpoint. We read callbackUrl from the request body and POST the payload there.',
      number: 598,
      author: 'dev.patel',
      base: 'main',
      branch: 'feat/webhook-forwarding',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'src/api/public/webhooks.ts',
          start_line: 17,
          end_line: 17,
          title: 'SSRF: outbound fetch to a caller-controlled URL',
          severity: 'CRITICAL',
          category: 'security',
        },
      ],
    },
  },
  {
    name: 'missing-retry-after',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'The new limiter answers 429 without a Retry-After header, so well-behaved clients cannot back off and instead hot-loop - a self-inflicted amplification of the load the limiter exists to shed.',
    inputDiff: MISSING_RETRY_AFTER_DIFF,
    inputMeta: {
      title: 'Add rate limiting to public API endpoints',
      body: 'Token-bucket limiter in front of the unauthenticated endpoints. Over-budget callers get a 429.',
      number: 482,
      author: 'marisa.koch',
      base: 'main',
      branch: 'feat/rate-limit-public',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'src/middleware/ratelimit.ts',
          start_line: 34,
          end_line: 39,
          title: '429 response omits the Retry-After header',
          severity: 'WARNING',
          category: 'bug',
        },
      ],
    },
  },
  {
    name: 'clean-refactor-no-flags',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'A genuinely clean diff: one helper extracted, one function renamed, behaviour unchanged. Any finding here is a false positive - this is the case that lets precision move.',
    inputDiff: CLEAN_REFACTOR_DIFF,
    inputMeta: {
      title: 'Extract a seconds() helper out of the duration formatter',
      body: 'Pure refactor. formatDuration returns exactly what fmt returned; the only change is the extracted helper and the clearer name.',
      number: 623,
      author: 'lena.fischer',
      base: 'main',
      branch: 'chore/format-refactor',
    },
    expectedOutput: {
      kind: 'must_not_flag',
      expectations: [{ file: 'src/utils/format.ts', start_line: 3, end_line: 11 }],
    },
  },
  {
    name: 'service-role-in-client',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'A privileged Supabase service-role key is read from a "use client" module, so it ships in the browser bundle and bypasses every row-level-security policy.',
    inputDiff: SERVICE_ROLE_IN_CLIENT_DIFF,
    inputMeta: {
      title: 'Fix "row level security" errors on the dashboard',
      body: 'The anon key kept failing RLS on the dashboard queries. Switching the browser client to the service-role key makes the queries work.',
      number: 634,
      author: 'dev.patel',
      base: 'main',
      branch: 'fix/dashboard-rls',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'web/src/lib/supabase.ts',
          start_line: 6,
          end_line: 6,
          title: 'Supabase service-role key used in browser-side code',
          severity: 'CRITICAL',
          category: 'security',
        },
      ],
    },
  },
  {
    name: 'sql-injection-string-concat',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'The user search builds raw SQL by concatenating req.query.q and req.query.limit straight into the statement - textbook injection on a public endpoint.',
    inputDiff: SQL_INJECTION_DIFF,
    inputMeta: {
      title: 'Add user search to the admin API',
      body: 'Support searching users by a fragment of their email. Uses db.raw because the LIKE pattern needs the wildcards inline.',
      number: 640,
      author: 'sam.ortiz',
      base: 'main',
      branch: 'feat/user-search',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'src/api/users.ts',
          start_line: 43,
          end_line: 47,
          title: 'SQL injection: request input concatenated into a raw query',
          severity: 'CRITICAL',
          category: 'security',
        },
      ],
    },
  },
  {
    name: 'path-traversal-download',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'req.query.name is joined onto the upload directory with no basename or containment check, so ../../ escapes it and serves arbitrary files.',
    inputDiff: PATH_TRAVERSAL_DIFF,
    inputMeta: {
      title: 'Serve uploaded files by name',
      body: 'Adds GET /files/download?name=... so the client can fetch a previously uploaded attachment.',
      number: 645,
      author: 'sam.ortiz',
      base: 'main',
      branch: 'feat/file-download',
    },
    expectedOutput: {
      kind: 'must_find',
      expectations: [
        {
          file: 'src/api/files.ts',
          start_line: 25,
          end_line: 25,
          title: 'Path traversal: user-supplied filename joined onto the upload directory',
          severity: 'CRITICAL',
          category: 'security',
        },
      ],
    },
  },
  {
    name: 'test-fixture-fake-token',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'A throwaway constant inside a test spec. Flagging it as a hardcoded secret is the classic security-reviewer false positive and trains the user to ignore the agent.',
    inputDiff: TEST_FIXTURE_TOKEN_DIFF,
    inputMeta: {
      title: 'Cover token signing and verification',
      body: 'Unit tests for signToken/verifyToken. The secret is a literal so the test stays deterministic and offline.',
      number: 651,
      author: 'lena.fischer',
      base: 'main',
      branch: 'test/auth-tokens',
    },
    expectedOutput: {
      kind: 'must_not_flag',
      expectations: [
        { file: 'src/api/__tests__/auth.test.ts', start_line: 6, end_line: 14 },
      ],
    },
  },
  {
    name: 'env-example-placeholder',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'Empty placeholder keys in a committed .env.example. The names of secrets are documentation, not a leak - the values are deliberately blank.',
    inputDiff: ENV_EXAMPLE_DIFF,
    inputMeta: {
      title: 'Document the Stripe and OpenRouter environment variables',
      body: 'Adds the new variables to .env.example with empty values so a fresh checkout knows what to fill in.',
      number: 658,
      author: 'marisa.koch',
      base: 'main',
      branch: 'docs/env-example',
    },
    expectedOutput: {
      kind: 'must_not_flag',
      expectations: [{ file: '.env.example', start_line: 4, end_line: 7 }],
    },
  },
  {
    name: 'jwt-verify-already-correct',
    ownerAgentName: SECURITY_REVIEWER,
    notes:
      'This diff is the FIX: jwt.decode is replaced by a fully-checked jwt.verify with an algorithm allow-list. An agent that pattern-matches on "jwt" and warns anyway is producing noise on a security improvement.',
    inputDiff: JWT_VERIFY_DIFF,
    inputMeta: {
      title: 'Verify access tokens instead of decoding them',
      body: 'jwt.decode does not check the signature. Replaced with jwt.verify pinned to RS256, with issuer, audience and clock tolerance.',
      number: 662,
      author: 'dev.patel',
      base: 'main',
      branch: 'fix/verify-access-token',
    },
    expectedOutput: {
      kind: 'must_not_flag',
      expectations: [{ file: 'src/auth/verify.ts', start_line: 11, end_line: 21 }],
    },
  },
];
