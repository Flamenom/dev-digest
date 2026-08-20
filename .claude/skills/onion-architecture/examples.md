# onion-architecture — good/bad pairs on this codebase

Every "bad" below is **real code in this repo today**, cited by `file:line`, and every one is
reported by `pnpm arch`. Fix them as you touch the module (SKILL.md §13); do not silence them.

---

## 1. Service depends on the composition root

`server/src/modules/reviews/service.ts:33` · rules `no-container-inward`, `no-circular`

```ts
// ❌ the service reaches out to the composition root and builds its own infrastructure
export class ReviewService {
  private repo: ReviewRepository;
  private agents: Container['agentsRepo'];
  private executor: ReviewRunExecutor;

  constructor(private container: Container) {
    this.repo = new ReviewRepository(container.db);   // application ring → infrastructure ctor
    this.agents = container.agentsRepo;
    this.executor = new ReviewRunExecutor(container, this.repo, this.agents);
  }
}
```

Every concrete adapter the container can build is now a transitive dependency of the service, and
`RepoIntelService(this)` closes a real `container → service → container` cycle.

```ts
// ✅ the service declares exactly what it needs; the root supplies it
export interface ReviewServiceDeps {
  reviewRepo: ReviewRepository;
  agentsRepo: AgentsRepository;
  runBus: RunBus;
  llm: (id: ProviderId) => Promise<LLMProvider>;
  repoIntel: RepoIntel;
  git: GitClient;
}

export class ReviewService {
  private executor: ReviewRunExecutor;
  constructor(private deps: ReviewServiceDeps) {
    this.executor = new ReviewRunExecutor(deps);
  }
}

// platform/container.ts — the ONE place that knows the concrete wiring
get reviewService(): ReviewService {
  return (this._reviewService ??= new ReviewService({
    reviewRepo: this.reviewRepo,
    agentsRepo: this.agentsRepo,
    runBus: this.runBus,
    llm: (id) => this.llm(id),
    repoIntel: this.repoIntel,
    git: this.git,
  }));
}
```

The test win is the point: a `ReviewService` test now needs six fakes it can see, not a whole
`Container`.

---

## 2. Drizzle row types leaking into the application ring

`server/src/modules/reviews/run-executor.ts:5,58,141` · rule `no-db-schema-outside-repo`

```ts
// ❌ the executor's PUBLIC method signature is typed by the physical table
import * as schema from '../../db/schema.js';
import type { AgentRow } from '../../db/rows.js';

async runOne(
  agent: AgentRow,
  repo: typeof schema.repos.$inferSelect,   // ← any migration is a breaking change here
): Promise<RunOutcome> { … }
```

```ts
// ✅ a domain type declared in the core; the repository maps at its boundary
// vendor/shared/contracts/<new-file>.ts
export interface RepoTarget { id: string; owner: string; name: string; defaultBranch: string; }
export interface Agent { id: string; name: string; provider: ProviderId; model: string; enabled: boolean; }

// modules/reviews/repository/pull.repo.ts — mapping lives HERE and nowhere else
const toRepoTarget = (r: typeof t.repos.$inferSelect): RepoTarget => ({
  id: r.id, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch,
});

// modules/reviews/run-executor.ts
async runOne(agent: Agent, repo: RepoTarget): Promise<RunOutcome> { … }
```

Same fix applies to `modules/reviews/service.ts:4` (`AgentRow`) and
`modules/reviews/diff-loader.ts:4,17`.

---

## 3. A route running its own queries

`server/src/modules/workspace/routes.ts:2` (also `settings`, `pulls`, `polling`) · rules
`no-db-outside-repo`, `no-db-schema-outside-repo`

```ts
// ❌ presentation reaches straight past the repository into the tables
import { eq } from 'drizzle-orm';
import * as t from '../../db/schema.js';

app.get('/workspace', async (req) => {
  const { workspaceId } = await getContext(container, req);
  const [row] = await container.db.select().from(t.workspaces).where(eq(t.workspaces.id, workspaceId));
  return row;
});
```

```ts
// ✅ one named repository method; the route stays a translator
// modules/workspace/repository.ts
export class WorkspaceRepository {
  constructor(private db: Db) {}
  getWorkspace(workspaceId: string): Promise<Workspace | undefined> { … }  // returns a DOMAIN type
}

// modules/workspace/routes.ts
app.get('/workspace', async (req) => {
  const { workspaceId } = await getContext(container, req);
  const ws = await service.get(workspaceId);
  if (!ws) throw new NotFoundError('Workspace not found');
  return ws;
});
```

Note what stays in the route: `getContext(container, req)`. Tenancy resolution is a
presentation-edge concern — the service receives a plain `workspaceId: string`.

---

## 4. An adapter running SQL

`server/src/adapters/auth/local.ts:2,4` · rules `no-db-outside-repo`, `no-db-schema-outside-repo`

```ts
// ❌ one file is both "the auth port implementation" and "a query layer"
import { eq } from 'drizzle-orm';
import * as t from '../../db/schema.js';

export class LocalNoAuthProvider implements AuthProvider {
  constructor(private db: Db) {}
  async currentWorkspace() {
    const [ws] = await this.db.select().from(t.workspaces).where(eq(t.workspaces.slug, 'default'));
    return ws;
  }
}
```

```ts
// ✅ the adapter implements the port and delegates persistence
export class LocalNoAuthProvider implements AuthProvider {
  constructor(private workspaces: WorkspaceRepository, private users: UserRepository) {}
  currentWorkspace() { return this.workspaces.getDefault(); }
  currentUser()      { return this.users.getSystemUser(); }
}
```

The adapter still lives in the infrastructure ring — it just stops owning two concerns at once, and
the tenant query becomes reusable and testable on its own.

---

## 5. A pure function stranded in `adapters/`

`server/src/modules/reviews/diff-loader.ts:3` · rule `no-concrete-adapter-outside-root`

```ts
// ❌ the application ring imports outward to reach a function with no I/O at all
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
```

`parseUnifiedDiff` is a stateless string→`UnifiedDiff` parser. The violation is not the import — it
is the *placement*.

```ts
// ✅ move the function inward; it is domain logic about a diff format
// reviewer-core/src/diff/parse-unified.ts   (pure, testable, no adapter in sight)
export function parseUnifiedDiff(patch: string): UnifiedDiff { … }

// modules/reviews/diff-loader.ts
import { parseUnifiedDiff } from '@devdigest/reviewer-core';
```

Same call for `adapters/codeindex/extract.ts` and the pure helpers in `adapters/astgrep/index.ts`,
which `repo-intel` imports from three places. **Do not** add a `pathNot` exception for these — the
rule is telling you the truth.

---

## 6. Adding a new external tool — the five steps

`adapters/depgraph` and `adapters/tokenizer` are the models. To add, say, a container registry client:

```ts
// 1. PORT — a NEW file under vendor/shared (never edit an existing contract)
// server/src/vendor/shared/contracts/registry.ts
export interface ImageRegistry {
  listTags(image: string): Promise<string[]>;
  manifestDigest(image: string, tag: string): Promise<string>;
}

// 2. ADAPTER — one class, one vendor
// server/src/adapters/registry/oci.ts
export class OciRegistryClient implements ImageRegistry { constructor(private token: string) {} … }

// 3. CONTAINER GETTER — the only place the class is named
get registry(): ImageRegistry {
  if (this.overrides.registry) return this.overrides.registry;
  this._registry ??= new OciRegistryClient(this.config.registryToken);
  return this._registry;
}

// 4. OVERRIDE SLOT — so tests inject a fake
export interface ContainerOverrides { /* … */ registry?: ImageRegistry; }

// 5. CONSUME THE INTERFACE
constructor(private deps: { registry: ImageRegistry }) {}
```

Named after the **conversation** (`ImageRegistry`), not the vendor (`OciRegistryClient` is only the
adapter). A port named `OciClient` could never host a second implementation.

---

## 7. Transactions spanning two repositories

Ownership of the transaction belongs to the application ring, not the repository.

```ts
// ❌ each repository opens its own transaction — the two writes cannot be made atomic
await this.reviewRepo.insertReview(values);   // db.transaction inside
await this.runRepo.markRunSucceeded(runId);   // a second, separate transaction
```

```ts
// ✅ repository methods accept an optional tx; the service owns the boundary
// repository
insertReview(values: NewReview, tx: Db | Tx = this.db): Promise<Review> { … }
markRunSucceeded(runId: string, tx: Db | Tx = this.db): Promise<void> { … }

// service — one atomic use case across two repositories
await this.deps.db.transaction(async (tx) => {
  const review = await this.deps.reviewRepo.insertReview(values, tx);
  await this.deps.reviewRepo.insertFindings(review.id, kept, tx);
  await this.deps.runRepo.markRunSucceeded(runId, tx);
});
```

Drizzle rolls back automatically when the callback throws, and `tx.transaction()` nests via
savepoints if a sub-step needs its own boundary.

---

## 8. Cross-module reach vs the container

`server/src/modules/repos/service.ts:14` · rule `no-cross-module`

```ts
// ❌ two vertical slices welded together
import { INDEX_STALE_AFTER_MS } from '../repo-intel/constants.js';
```

```ts
// ✅ either the value is shared vocabulary → move it inward…
import { INDEX_STALE_AFTER_MS } from '@devdigest/shared';

// …or the behaviour belongs to the other slice → ask it through its facade
const stale = await this.deps.repoIntel.isStale(repoId);
```

Prefer the second form: if `repos` needs to know whether an index is stale, that is a `repo-intel`
question, and `RepoIntel` is already the interface for asking it.

---

## 9. Logger — the pattern to copy, not to change

`server/src/modules/reviews/run-executor.ts:21` — this is already **correct**; keep it.

```ts
// ✅ a port shaped by the consumer; pino satisfies it structurally, by accident
export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

// routes.ts passes req.log; the executor never imports fastify or pino
await service.runReview(workspaceId, req.params.id, targets, req.log);
```

```ts
// ❌ what NOT to do — the framework's type crosses into the application ring
import type { FastifyBaseLogger } from 'fastify';
async runOne(agent: Agent, log: FastifyBaseLogger) { … }
```

This is why `no-fastify-inward` is an `error` rule rather than a `warn`: the boundary is clean today.

---

## 10. Testing the right ring

```ts
// ❌ a service test that needs Postgres — the layering is wrong, not the test
// modules/reviews/service.it.test.ts
const pg = await new PostgreSqlContainer().start();
const service = new ReviewService(new Container(config, db));
```

```ts
// ✅ hermetic: fake the repository and the ports, assert the orchestration
const service = new ReviewService({
  reviewRepo: fakeReviewRepo(),
  agentsRepo: { listEnabled: async () => [enabledAgent] },
  runBus: new InMemoryRunBus(),
  llm: async () => stubLLM({ verdict: 'comment', findings: [] }),
  repoIntel: mockRepoIntel(),
  git: mockGitClient(),
});
```

Keep `*.it.test.ts` + testcontainers for the layer that actually owns SQL: the repository. Test the
port contract once against both the real adapter and the mock, so `adapters/mocks.ts` cannot drift.
