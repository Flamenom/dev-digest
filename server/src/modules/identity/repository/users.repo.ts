import { eq, inArray, sql } from 'drizzle-orm';
import type { ActorRefValue } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { UserRow } from '../../../db/rows.js';

// ---- Transaction plumbing shared by every identity repo file ---------------

/** The handle Drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type IdentityTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** What a method runs against — the client, or a caller-owned transaction. */
export type IdentityExecutor = Db | IdentityTx;

/**
 * A transaction exposes the same query builders as the client; the cast keeps
 * call sites free of a `Db | PgTransaction` union TypeScript can't resolve
 * overloads across (same pattern as the pulls / eval repositories).
 */
export function execOf(db: Db, tx?: IdentityExecutor): Db {
  return (tx ?? db) as Db;
}

/** Postgres unique-violation, matched by SHAPE (postgres-js error `code`). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '23505') return true;
    e = typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards `uuid` columns: a malformed id would make Postgres raise instead of matching nothing. */
export const isUuid = (value: string): boolean => UUID_RE.test(value);

// ---- Domain types -----------------------------------------------------------

/** A user as the identity module sees it (mapped from the row at this boundary). */
export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** Google `sub`; null for the seeded local system user. */
  googleSub: string | null;
  createdAt: Date;
  lastSignInAt: Date | null;
}

/** How a user is named to the outside (comment attribution): empty strings are reported as null. */
export interface DisplayIdentity {
  name: string | null;
  email: string | null;
}

/** Verified claims the sign-in flow upserts (never request-supplied data, AC-10). */
export interface UserClaims {
  subject: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface UpsertUserResult {
  user: IdentityUser;
  /** True when this call inserted the user (first sign-in). */
  created: boolean;
}

export function toUser(row: UserRow): IdentityUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    googleSub: row.googleSub,
    createdAt: row.createdAt,
    lastSignInAt: row.lastSignInAt,
  };
}

/**
 * The seeded system user (Q3 / AC-48). Every person who ever signed in has a
 * Google `sub`; the only rows without one are created by `db:seed` /
 * `db:bootstrap` (the local system user). Deliberately not an email match:
 * importing `db/seed.ts` would drag its adapters + dotenv side effects in.
 */
function isSystemUser(u: { googleSub: string | null }): boolean {
  return u.googleSub === null;
}

// ---- Repository -------------------------------------------------------------

/** `users` data access for the identity module. */
export class UsersRepo {
  constructor(private db: Db) {}

  /**
   * Insert-or-refresh the user keyed by Google `sub` (AC-11, AC-12): on conflict
   * only email / name / avatar / last_sign_in_at are refreshed — never the id.
   *
   * Concurrency (AC-13): `ON CONFLICT (google_sub)` serializes racing first
   * sign-ins, but the NON-arbiter unique index `users_google_lower_email_uq`
   * can still raise 23505 when both speculative inserts pass the pre-check at
   * once. The statement therefore runs in a savepoint (a transaction when no
   * `tx` is given) and is retried once — the retry takes the DO UPDATE path.
   */
  async upsertBySub(
    claims: UserClaims,
    now: Date,
    tx?: IdentityExecutor,
  ): Promise<UpsertUserResult> {
    const attempt = () =>
      execOf(this.db, tx).transaction(async (sp) => {
        const [row] = await sp
          .insert(t.users)
          .values({
            email: claims.email,
            name: claims.name,
            avatarUrl: claims.avatarUrl,
            googleSub: claims.subject,
            lastSignInAt: now,
          })
          .onConflictDoUpdate({
            target: t.users.googleSub,
            set: {
              email: sql`excluded.email`,
              name: sql`excluded.name`,
              avatarUrl: sql`excluded.avatar_url`,
              lastSignInAt: sql`excluded.last_sign_in_at`,
            },
          })
          .returning({
            id: t.users.id,
            email: t.users.email,
            name: t.users.name,
            avatarUrl: t.users.avatarUrl,
            googleSub: t.users.googleSub,
            createdAt: t.users.createdAt,
            lastSignInAt: t.users.lastSignInAt,
            // xmax = 0 ⇔ the row version was produced by INSERT, not the DO UPDATE arm.
            inserted: sql<boolean>`(xmax = 0)`,
          });
        return row!;
      });

    let row: Awaited<ReturnType<typeof attempt>>;
    try {
      row = await attempt();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      row = await attempt();
    }
    const { inserted, ...user } = row;
    return { user, created: inserted === true };
  }

  async findBySub(subject: string, tx?: IdentityExecutor): Promise<IdentityUser | undefined> {
    const [row] = await execOf(this.db, tx)
      .select()
      .from(t.users)
      .where(eq(t.users.googleSub, subject));
    return row ? toUser(row) : undefined;
  }

  async findById(userId: string, tx?: IdentityExecutor): Promise<IdentityUser | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await execOf(this.db, tx).select().from(t.users).where(eq(t.users.id, userId));
    return row ? toUser(row) : undefined;
  }

  /**
   * The user's display name + email (GitLab comment attribution footer, AC-16),
   * or null for an unknown / malformed id. Only these two columns are read.
   */
  async displayIdentity(userId: string): Promise<DisplayIdentity | null> {
    if (!isUuid(userId)) return null;
    const [row] = await this.db
      .select({ name: t.users.name, email: t.users.email })
      .from(t.users)
      .where(eq(t.users.id, userId));
    return row ? { name: row.name || null, email: row.email || null } : null;
  }

  /**
   * Batch actor lookup (`ActorDirectory`, Rec-3): ONE `IN (...)` query.
   * Unknown / malformed ids are absent from the map; the seeded system user is
   * flagged `is_system: true` so the UI can label it "Local user".
   */
  async lookupActors(ids: readonly string[]): Promise<Map<string, ActorRefValue>> {
    const wanted = [...new Set(ids)].filter(isUuid);
    const out = new Map<string, ActorRefValue>();
    if (wanted.length === 0) return out;
    const rows = await this.db
      .select({
        id: t.users.id,
        name: t.users.name,
        googleSub: t.users.googleSub,
      })
      .from(t.users)
      .where(inArray(t.users.id, wanted));
    for (const r of rows) {
      out.set(
        r.id,
        isSystemUser(r) ? { user_id: r.id, name: r.name, is_system: true } : { user_id: r.id, name: r.name },
      );
    }
    return out;
  }
}
