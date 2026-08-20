---
name: onion-architecture
description: "Onion Architecture for the DevDigest backend (server + reviewer-core). Use when deciding WHICH RING a backend file belongs to and which imports are legal from it — where a service/repository/adapter/port/contract goes, whether Fastify or Drizzle may appear in a file, how to add a new external tool behind a port, how to wire dependencies through the DI container, and how to keep reviewer-core pure. Also use when reviewing a backend module for layering violations or running the `pnpm arch` fitness function. Trigger terms: onion architecture, clean architecture, hexagonal, ports and adapters, dependency rule, layering, ring, domain layer, application layer, infrastructure layer, repository pattern, DI container, composition root, dependency-cruiser, pnpm arch, layer violation, domain leakage."
version: 1.0.0
---

# Onion Architecture — DevDigest backend

Macro-level backend architecture: **which ring does this file live in, and what may it import.**
Scope is `server/` + `reviewer-core/` (reviewer-core *is* the domain core).

This skill answers placement and dependency-direction questions. It deliberately does **not**
repeat tool mechanics: Fastify routes/hooks → [`fastify-best-practices`](../fastify-best-practices/SKILL.md),
Drizzle query syntax → [`drizzle-orm-patterns`](../drizzle-orm-patterns/SKILL.md),
table design → [`postgresql-table-design`](../postgresql-table-design/SKILL.md),
schema authoring → [`zod`](../zod/SKILL.md), type-level work → [`typescript-expert`](../typescript-expert/SKILL.md).
Frontend layering → [`frontend-ui-architecture`](../frontend-ui-architecture/SKILL.md).

For good/bad pairs on this codebase, see [examples.md](./examples.md). For sources, see [README.md](./README.md).

## Scope

- ✅ Ring placement: where a service / repository / adapter / port / contract / helper belongs
- ✅ Legal import directions, and the mechanical gate that enforces them (`pnpm arch`)
- ✅ How Fastify, Drizzle, Zod, the DI container and `reviewer-core` map onto rings
- ✅ Adding a new external tool behind a port; wiring it in the composition root
- ✅ Which ring a test belongs to (hermetic vs `*.it.test.ts`)
- ❌ Route/hook/plugin mechanics, query syntax, schema authoring → the sibling skills above
- ❌ Frontend structure → `frontend-ui-architecture`

---

## 1. The one rule everything else follows

**Imports point inward only. Never outward, never sideways between feature modules.**

```
┌─ presentation ─── modules/<m>/routes.ts · modules/index.ts · platform/sse.ts
│ ┌─ infrastructure ─ adapters/* · modules/<m>/repository* · db/* · platform/{jobs,run-logger,resilience}.ts
│ │ ┌─ application ── modules/<m>/{service,run-executor,diff-loader,helpers}.ts
│ │ │ ┌─ domain ───── reviewer-core/src/* · platform/grounding.ts
│ │ │ │ └─ core ───── vendor/shared/contracts/* (Zod contracts) · vendor/shared/adapters.ts (ports)
│ │ │ │
└─┴─┴─┴─ composition root: platform/container.ts — OUTSIDE the rings
```

Three corollaries, and they are the whole skill:

1. **The core defines the shape; the outside fits into it.** A port is an interface in
   `vendor/shared/adapters.ts`; the adapter in `adapters/<name>/` implements it. The domain never
   reaches out to an adapter — the adapter fits a shape the domain already declared.
2. **Only the composition root names a concrete class.** `platform/container.ts` is the single file
   allowed to write `new OctokitGitHubClient(...)`. Everything else depends on the interface.
   Nothing imports the container except `routes.ts` and bootstrap.
3. **Feature modules are vertical slices inside the horizontal rings.** A module never imports a
   sibling module's folder — cross-cutting entities come from the container
   (`container.agentsRepo`, `container.repoIntel`). This is the "sliced onion": without the vertical
   cut the domain becomes one opaque block, which is the standard and correct critique of plain onion.

---

## 2. Ring placement — decision order

Ask in order; stop at the first "yes".

| Question | Ring | Put it in |
|---|---|---|
| Is it a wire/domain **shape** shared by web + api + engine? | core contracts | a **new file** in `vendor/shared/contracts/` |
| Is it an **interface** describing a conversation with the outside world? | core ports | `vendor/shared/adapters.ts` (extend, never rewrite) |
| Is it a **decision rule** — scoring, grounding, prompt assembly, reduce? | domain | `reviewer-core/src/` |
| Does it **orchestrate** a use case (fetch → decide → persist → emit)? | application | `modules/<m>/service.ts` (or `run-executor.ts` when bulky) |
| Does it **run queries**? | infrastructure | `modules/<m>/repository.ts` (+ `repository/<aggregate>.repo.ts`) |
| Does it **call something external** (HTTP, git, subprocess, SDK)? | infrastructure | `adapters/<name>/` implementing a port |
| Does it **translate HTTP** ↔ arguments? | presentation | `modules/<m>/routes.ts` |
| Does it **construct** things and resolve secrets? | composition root | `platform/container.ts` |

**Ambiguity tiebreaker:** ask *what would have to change for this file to change*. If the answer is
"a business rule" it goes inward; if it is "a vendor, a wire format, a table" it goes outward.

**Pure functions are not infrastructure.** A stateless parser or extractor sitting in `adapters/`
(`git/diff-parser.ts`, `codeindex/extract.ts`) is misplaced: it has no I/O, so it belongs in the
domain ring. When you catch an inward module importing one of these, move the *function*; do not
add an exception for the *import*.

---

## 3. Ports & adapters

**Port** = interface in `vendor/shared/adapters.ts`. **Adapter** = class in `adapters/<name>/`.
Every external call goes behind a port — that is the existing contract in that file's own header:
*"ALL external calls go behind these interfaces."*

Adding a new external tool — the five steps, in this order:

1. **Port**: declare the interface. `vendor/shared` is do-not-touch for *edits* — **add a new file**
   and re-export it; never modify an existing contract (it breaks web↔api↔engine lockstep).
2. **Adapter**: `adapters/<name>/<impl>.ts` implements the port. One class, one vendor.
3. **Container getter**: a lazy getter in `platform/container.ts`, resolving keys via
   `SecretsProvider`. Follow the existing shape — `??=` cache, `overrides` checked first.
4. **Override slot**: add the field to `ContainerOverrides` so tests inject a fake.
5. **Consume the interface**, never the class. `adapters/depgraph` and `adapters/tokenizer` are the
   models to copy.

Name ports after the **conversation**, not the vendor: `CodeIndex`, not `RipgrepClient`;
`Embedder`, not `OpenAIEmbeddingsApi`. A port named after a vendor cannot have a second adapter.

---

## 4. Fastify is presentation-only

The framework lives in the outermost ring and must not appear inward. This currently holds across
all 8 modules — `no-fastify-inward` is an **`error`** rule. Keep it that way.

- **Routes translate, they do not decide.** `routes.ts` parses params/body, resolves tenancy via
  `getContext(container, req)`, calls one service method, shapes the response. Business branching in
  a route is a misplaced use case.
- **Services take plain arguments.** `workspaceId: string`, not `req`. `FastifyRequest`,
  `FastifyReply` and `req.log`'s pino types must not cross into `service.ts`.
- **Inject a structural logger.** `modules/reviews/run-executor.ts` defines a 4-method `Logger`
  type that pino satisfies incidentally. That is the correct pattern: a port shaped by the consumer,
  not an import of the framework's logger type. Reuse it, don't re-derive it.
- **Plugin encapsulation is the module seam.** One module = one Fastify plugin, registered
  statically in `modules/index.ts`. Fastify's context tree is unidirectional — a child sees the
  parent's decorators, never the reverse. Reach for `fastify-plugin` only for a deliberate
  cross-cutting concern; it breaks encapsulation for exactly the plugin it wraps.
- **Route Zod schemas are the trust boundary**, not domain validation. See §6.
- `platform/sse.ts` and the SSE generator in a route are presentation. The `RunBus` an executor
  publishes to is a port-shaped seam — the application ring emits `RunEvent`s and knows nothing
  about HTTP streaming.

---

## 5. Drizzle is infrastructure-only

The repository is the **only** layer that runs queries. Two rules, both currently at `warn` with a
known backlog (§13).

- **No `drizzle-orm` / `postgres` import outside** `db/`, `modules/<m>/repository*`,
  `platform/{container,jobs}.ts`, and bootstrap. A route writing its own `eq(...)` has skipped the
  repository entirely — today `workspace`, `settings`, `pulls` and `polling` routes do this, and so
  does `adapters/auth/local.ts`.
- **No `$inferSelect` row type outside the repository.** `db/rows.ts` and `db/schema.ts` must not be
  imported by a service, executor or route. Map row → domain type **at the repository boundary**.
  Exposing DB row types to outer layers is the single most consequential mistake in this pattern:
  it couples your API contract to your table layout, so every migration is a breaking change.
  Today `modules/reviews/{service,run-executor,diff-loader}.ts` and `modules/settings/feature-models.ts`
  violate this; `run-executor.ts` even types two public method parameters as
  `typeof schema.repos.$inferSelect`.
- **Repository methods speak domain, not SQL.** `listEnabled(workspaceId)`, not
  `selectAgentsWhereEnabled`. `cancelRunIfRunning(runId)`, not `updateStatusColumn`. The existing
  `ReviewRepository` API is a good example of this naming.
- **Transaction boundaries belong to the application ring.** Repository methods accept an optional
  `tx` so a service can span several repositories in one `db.transaction(...)`. A repository that
  opens its own transaction cannot be composed.
- **Translate DB errors at the boundary.** A unique-constraint violation becomes a domain error
  (`platform/errors.ts`), not a leaked `postgres` error object. Never return a Drizzle query builder
  from a repository — that hands ORM internals to the caller.
- **`workspace_id` scoping is a repository invariant.** Every domain table carries it; the repository
  is where "we never forget the tenant filter" is guaranteed.
- **Schemas model the physical database**, not the ideal domain. `db/schema/*` describes tables,
  columns, indexes and constraints; it encodes no business rules. Keep pgvector dimensions and other
  storage facts there, out of the domain.

---

## 6. Zod: three distinct jobs — don't collapse them

| Use | Where | Ring |
|---|---|---|
| **Wire/domain contract** shared by web + api + engine | `vendor/shared/contracts/*` | core |
| **Trust boundary** — parse untrusted input at the edge | route `schema:` via `fastify-type-provider-zod`; `RunRequest.parse(req.body)` | presentation |
| **Projection / DTO** for a response | `modules/<m>/helpers.ts` (`reviewToDto`) | application → presentation |

The core contract is the innermost shared language; the route schema is an anti-corruption layer at
the perimeter; the DTO is an outward projection so the API shape does not track the DB shape. A
single Zod object doing all three is how table columns end up in your public API.

Gotcha that follows from the boundary: `ZodError` is matched **by shape, not `instanceof`**, because
zod is vendored twice (server copy vs api copy). That is a symptom of the vendoring seam — handle it
where errors are translated, not by unifying the copies.

---

## 7. The application ring (services)

A service **orchestrates** a use case. It may: call ports, call its repository, call the domain,
publish events. It may **not**: run SQL, construct adapters, import the container, or touch Fastify.

- **Take an explicit deps object.** The current `ReviewService(container)` shape is the main
  outstanding violation: the service depends on the composition root and does
  `new ReviewRepository(container.db)` itself — an outward import that drags in every concrete
  adapter transitively, and produces a real `container ↔ repo-intel/service` import cycle. The fix
  is mechanical: the constructor takes `{ reviewRepo, agentsRepo, llm, runBus, … }`, built once in
  the container. See [examples.md](./examples.md) §1.
- **No `import type { Container }`** in a service, executor, or repository.
- **Keep the executor in the application ring.** `run-executor.ts` orchestrates; the decisions it
  applies (grounding, reduce, scoring) live in `reviewer-core`. If you find yourself writing a
  scoring rule in the executor, it belongs inward.
- Fire-and-forget runs stay an application concern: the runId is minted synchronously so the client
  can subscribe, and the trace is persisted as one document. That is orchestration, not policy.

---

## 8. The domain core (`reviewer-core`)

The innermost ring, and the one part of the repo that is already clean — `core-purity`,
`core-no-server-imports` and `core-no-io-builtins` are all **`error`** rules and all pass.

Invariants, restated as enforceable rules:

- **The only side effect is `llm.completeStructured`.** No DB, no GitHub, no git, no filesystem, no
  subprocess, no direct HTTP.
- **Server code is reachable only through `vendor/shared`.** Nothing else from `server/src`.
- **Inputs arrive already resolved.** Skills, memory and specs are plain strings; the engine performs
  no lookups. Progress and cancellation are injected callbacks (`onEvent`, `checkCancelled`) — the
  engine has no coupling to SSE or to server error types.
- **The grounding gate and the deterministic re-score are domain policy.** A finding must cite a real
  diff line or it is dropped; the score is recomputed from surviving findings and the model's number
  is never trusted. Do not relax these, and do not move them outward into a service where they could
  be bypassed.
- The one concrete provider that lives here (`llm/openrouter.ts`) is deliberate — it is shared with
  the CI runner and is injected, not resolved. It does not license adding more I/O.

---

## 9. Vertical slices — the cross-module rule

A feature module owns its slice top to bottom and stays independent.

- **Never import a sibling module's folder.** Today there is exactly one such import
  (`modules/repos/service.ts` → `modules/repo-intel/constants.ts`); keep it at one and drive it to zero.
- Cross-cutting entities resolve through the container: `container.agentsRepo`, `container.reviewRepo`,
  `container.repoIntel`. The container constructs these shared repositories precisely so a consumer
  never reaches into another module's data layer.
- A facade interface is the right seam for a big subsystem: `RepoIntel` is an interface that higher
  features code against, with `RepoIntelService` behind it and a mock injectable via
  `ContainerOverrides.repoIntel`.
- Shared route helpers live in `modules/_shared/` — the one slice everything may import.

---

## 10. Tests mirror the rings

- **Domain + application → hermetic.** Inject fakes: `adapters/mocks.ts` and `ContainerOverrides`.
  `reviewer-core` tests run against a stubbed `LLMProvider` — no keys, no network.
- **Infrastructure → `*.it.test.ts`** with testcontainers Postgres. The filename is the switch.
- **If a service test needs Postgres, the layering is wrong.** That is the clearest single signal
  this skill gives you: the service is reaching through the repository instead of depending on it.
- Contract-test a port once against every adapter (real + mock) so the fake cannot drift from the
  real implementation.

---

## 11. Enforcement — `pnpm arch`

The dependency rule is mechanical, not advisory. `server/.dependency-cruiser.cjs` encodes it and
`pnpm arch` (in `server/`) runs it over `src` **and** `../reviewer-core/src`. No new dependency was
needed — `dependency-cruiser` was already installed for `adapters/depgraph`.

> **Node version:** dependency-cruiser follows the node.js release cycle and refuses odd-numbered
> releases. Use node `^20.12 || ^22 || >=24`. On node 23 it exits with a version error.

| Rule | Severity | Guards |
|---|---|---|
| `core-purity` | **error** | reviewer-core → db / web framework / octokit / git / ast-grep |
| `core-no-server-imports` | **error** | reviewer-core → `src/` other than `vendor/shared` |
| `core-no-io-builtins` | **error** | reviewer-core → `fs`, `child_process`, `http`, `net`, … |
| `no-fastify-inward` | **error** | module innards → fastify packages |
| `no-fastify-in-adapters` | **error** | adapters → fastify packages |
| `no-fastify-in-core` | **error** | reviewer-core → fastify packages |
| `no-db-outside-repo` | warn | anything but db/repository/jobs/root/bootstrap → drizzle/postgres |
| `no-db-schema-outside-repo` | warn | anything but db/repository → `db/schema`, `db/rows` |
| `no-container-inward` | warn | module innards → `platform/container.ts` |
| `no-concrete-adapter-outside-root` | warn | anything but the root → `adapters/*` |
| `no-cross-module` | warn | `modules/a/**` → `modules/b/**` (`_shared` exempt) |
| `no-circular` | warn | any import cycle |

**Baseline at introduction: 41 warnings, 0 errors.** Every `error` rule passes today and must never
regress. The `warn` rules carry the known backlog in §13.

**Escape hatches must be explicit.** If a violation is genuinely correct, add a narrowly-scoped
`pathNot` exception in the config **with a comment saying why** — as the bootstrap and
module-registry exemptions do. Never widen a rule to silence a real violation, and never delete a
rule to make the output clean.

Run it before you commit backend changes, and read the rule `comment` — each one states the fix, not
just the ban.

---

## 12. Anti-patterns

| Smell | Why it breaks the ring | Fix |
|---|---|---|
| `constructor(private container: Container)` | application → composition root; drags in every adapter, creates cycles | explicit deps object built in the container |
| `new SomeRepository(container.db)` inside a service | service constructs its own infrastructure | inject the repository |
| `AgentRow` / `$inferSelect` in a service or route signature | table layout becomes the public API | map row → domain type in the repository |
| `eq(...)` in `routes.ts` | presentation reaching past the repository | add a repository method named for the operation |
| Adapter running its own SQL (`adapters/auth/local.ts`) | two infrastructure concerns fused | adapter delegates to a repository or takes a port |
| Port named after a vendor (`RipgrepClient`) | cannot ever have a second adapter | name the conversation (`CodeIndex`) |
| Pure parser living in `adapters/` | inward code must import outward to use it | move the function into the domain ring |
| `import { ... } from '../other-module/...'` | slices coupled sideways | go through the container |
| Business branching inside a route handler | use case in the presentation ring | move to the service; route stays a translator |
| Scoring/grounding logic in `run-executor.ts` | policy in the orchestration ring | move into `reviewer-core` |
| Service test spinning up testcontainers | service depends on the DB, not on the repository | inject a fake repository |

**And the counterweight — do not over-engineer.** Onion earns its boilerplate at seams that
actually change: the LLM provider, the git host, the database, the code index. It does not earn it
everywhere.

- Do **not** add a ring per file, or an interface with exactly one implementation and no test fake.
- Do **not** build an anemic domain plus pass-through services that only forward calls — that is the
  standard, fair critique of layered architectures. If a service method only forwards to the
  repository, the use case is thin and that's fine; don't invent a domain object to justify a layer.
- Do **not** mirror every DB row with a hand-written domain twin when the row *is* the concept and
  never crosses the wire. Map where it crosses a boundary.
- The rings are about **direction of dependency**, not about file count.

---

## 13. Migration order (do not big-bang)

Per module, in this order — each step is independently shippable:

1. **Contracts** — add the domain types the module needs (new files in `vendor/shared`).
2. **Repository boundary** — map row → domain type; stop exporting `$inferSelect` past the repo.
3. **Service deps** — replace `Container` with an explicit deps object; wire it in the container.
4. **Route thinning** — move any query/branching out of `routes.ts` into a named repository/service method.
5. **Flip the rule** — once the module is clean, tighten the relevant `warn` to `error`.

Backlog ranked by violation count (`pnpm arch`, baseline 41):

| Area | Warnings | Dominant problem |
|---|---|---|
| `repo-intel` | 14 | container-inward across service + pipeline, adapter imports, 4 cycles |
| `reviews` | 8 | container-inward + `db/{schema,rows}` in service / executor / diff-loader |
| `settings` | 5 | `feature-models.ts` does its own Drizzle queries |
| `adapters` | 3 | `auth/local.ts` runs SQL |
| `repos` | 3 | container-inward + the one cross-module import |
| `agents`, `polling`, `pulls`, `workspace` | 2 each | routes importing drizzle / schema directly |

Recommended sequence: **`reviews` first** (highest value — it is the core use case and the deps-object
refactor unblocks the pattern for everything else), then `settings` and the four route-level
offenders (small, mechanical), then `repo-intel` last (largest, and its cycles disappear once
`no-container-inward` is fixed).

Do **not** silence a warning to move a module off the list.
