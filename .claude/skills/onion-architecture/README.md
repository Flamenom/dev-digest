# onion-architecture — sources & rationale

**Version:** 1.0.0
**Scope:** Onion Architecture for the DevDigest **backend** — `server/` + `reviewer-core/`.
Dependency direction & ring placement, **not** tool mechanics.
**Complements:** [`fastify-best-practices`](../fastify-best-practices/SKILL.md) (route/hook/plugin
mechanics) · [`drizzle-orm-patterns`](../drizzle-orm-patterns/SKILL.md) (query syntax) ·
[`postgresql-table-design`](../postgresql-table-design/SKILL.md) (schema design) ·
[`zod`](../zod/SKILL.md) (schema authoring) · [`typescript-expert`](../typescript-expert/SKILL.md).
Frontend counterpart: [`frontend-ui-architecture`](../frontend-ui-architecture/SKILL.md).

**Artifacts this skill ships with:**

| File | Purpose |
|---|---|
| [SKILL.md](./SKILL.md) | the 13 sections: rings, placement, per-tool rules, enforcement, migration order |
| [examples.md](./examples.md) | 10 good/bad pairs, every "bad" a real `file:line` in this repo |
| `server/.dependency-cruiser.cjs` | the fitness function — 12 rules (6 `error`, 6 `warn`) |
| `server/package.json` → `pnpm arch` | runs the gate over `src` + `../reviewer-core/src` |

---

## How the rules were derived

Two inputs, deliberately kept separate:

**1. What the codebase already does.** The ring model in §1 was reverse-engineered from the existing
layout, not imposed on it: `vendor/shared/adapters.ts` already declares *"ALL external calls go behind
these interfaces"*; `platform/container.ts` is already a composition root with lazy getters and a
`ContainerOverrides` seam for tests; `reviewer-core` already documents its purity invariant; every
module already follows `routes → service → repository`. The skill names and enforces the architecture
that was implicit.

**2. Measured baseline.** `pnpm arch` was run against the real tree before the skill was written, so
every violation cited in SKILL.md §13 and examples.md is verified rather than assumed:
**41 warnings, 0 errors** across 149 modules / 463 dependencies. All six `error` rules — the three
`reviewer-core` purity rules and the three "Fastify never goes inward" rules — pass today, which is
why they were set to `error` rather than `warn`.

Two claims from the initial plan were **corrected by this measurement**:
- "`req.log` leaks Fastify types into the application ring" — **wrong**. `run-executor.ts:21` defines
  a narrow 4-method structural `Logger` that pino satisfies incidentally. It became a *good* example
  (examples.md §9) instead of a violation.
- "the reviews module is the worst offender" — **incomplete**. `repo-intel` carries more violations
  (14 vs 8), and there is a previously unnoticed cluster of four route files importing `drizzle-orm`
  directly. §13 was re-ranked from the actual counts.

`dependency-cruiser` needed no new dependency — it was already installed for
`adapters/depgraph` (repo-intel's import-graph builder).

---

## Tier 1 — canonical / primary

- [Jeffrey Palermo — The Onion Architecture: part 1 (2008)](https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/) —
  the origin of the term; parts 2–4 (incl. *After Four Years*) are indexed on
  [the onion-architecture tag](https://jeffreypalermo.com/tag/onion-architecture/). Source of the
  dependency rule and of "the core has zero knowledge of infrastructure" → **§1**.
- [Alistair Cockburn — Hexagonal Architecture (Ports & Adapters, 2005)](https://alistair.cockburn.us/hexagonal-architecture) —
  *"a port identifies a purposeful conversation"*; multiple adapters per port. Source of the
  "name the port after the conversation, not the vendor" rule → **§3**.
- [Herberto Graça — Onion Architecture (*The Software Architecture Chronicles*)](https://herbertograca.com/2017/09/21/onion-architecture/)
  ([Medium mirror](https://medium.com/the-software-architecture-chronicles/onion-architecture-79529d127f85)) —
  how onion reconciles with DDD layering and ports & adapters.
- [Fastify — Encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/) — the context
  tree is unidirectional (a child sees the parent's decorators, never the reverse); `fastify-plugin`
  breaks encapsulation *only for the plugin it wraps* → **§4**.
- [Fastify — The hitchhiker's guide to plugins](https://fastify.dev/docs/latest/Guides/Plugins-Guide/) ·
  [Plugins reference](https://fastify.dev/docs/latest/Reference/Plugins/) — plugins as cohesive blocks
  that "completely avoid cross dependencies" → the module-as-plugin seam in **§4/§9**.
- [Drizzle ORM — Transactions](https://orm.drizzle.team/docs/transactions) — `db.transaction(tx ⇒ …)`,
  nested savepoints via `tx.transaction()`, automatic rollback on throw, isolation levels. Basis for
  "transaction boundary = application ring, repositories accept an optional `tx`" → **§5**, examples §7.
- [dependency-cruiser — rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) —
  `forbidden` rules, `pathNot` exceptions, `$1` group back-references (used by `no-cross-module`),
  `circular`, `orphan` → **§11**.
- [Zod](https://github.com/colinhacks/zod) — schema as single source of truth for shape + runtime
  parse + inferred type → **§6**.

## Tier 2 — applied practice (Node / TypeScript layering)

- **[Paul Serban — Drizzle ORM Best Practices: Principles, Patterns and Real-World Case Studies](https://blog.paulserban.eu/post/drizzle-orm-best-practices-principles-patterns-and-real-world-case-studies/)**
  — the highest-value source for **§5**. Directly supplied: semantic repository interfaces
  (`authenticateUser`, not `findByEmailAndPassword`); *"exposing database types directly to API layers
  represents the most common and consequential mistake"*; map at repository boundaries; hide schema
  details behind the repository; pass transaction scope **in** rather than owning it; translate DB
  constraint violations into domain errors; never expose Drizzle query builders; schemas model the
  physical database, not the idealised domain; mock repositories for unit tests + real containers for
  integration + contract-test each implementation.
- [Sentry — Atomic Repositories in Clean Architecture and TypeScript](https://blog.sentry.io/atomic-repositories-in-clean-architecture-and-typescript/) —
  repository granularity and cross-repository atomicity in TS.
- [Khalil Stemmler — Clean Node.js Architecture](https://khalilstemmler.com/articles/enterprise-typescript-nodejs/clean-nodejs-architecture/) —
  layer responsibilities for enterprise Node/TS.
- [Sankhadip Samanta — Onion Architecture in Node.js with TypeScript](https://sankhadip.medium.com/onion-architecture-in-node-js-with-typescript-5508612a4391) —
  domain → application → infrastructure → presentation ordering in a TS codebase.
- [Melzar — onion-architecture-boilerplate (Node + TS)](https://github.com/Melzar/onion-architecture-boilerplate) —
  reference folder layout; "request object in, layer-specific translation out".
- [Saad Hasan — Ports and Adapters, explained with two real codebases](https://saadh393.github.io/blog/adapter-port-architecture-two-cases) —
  *"arrows always point inward, toward the port… adapters fit into a shape the business logic already
  defined"* → the phrasing of **§1** corollary 1.
- [generalistprogrammer — Hexagonal Architecture: complete TypeScript guide](https://generalistprogrammer.com/tutorials/hexagonal-architecture-complete-guide)
- [youngju.dev — Clean / Hexagonal / Onion / Ports & Adapters guide (2025)](https://www.youngju.dev/blog/culture/2026-04-14-clean-architecture-hexagonal-onion-ports-adapters-guide-2025.en) —
  reconciles the three competing vocabularies.
- [Code Maze — Onion Architecture in ASP.NET Core](https://code-maze.com/onion-architecture-in-aspnetcore/) —
  clearest ring taxonomy write-up (language-agnostic value).
- [NDepend — Onion Architecture: Going Beyond Layers](https://blog.ndepend.com/onion-architecture-layers/)

## Tier 3 — enforcement / fitness functions

- [Tiare Balbi — Architecture Fitness Functions in TypeScript](https://www.tiarebalbi.com/en/blog/fitness-function-test-that-fails-the-build) —
  layer boundaries, "no direct database access outside the repository layer" and "no cyclic
  dependencies" are the rules worth making **hard CI gates**, because they either hold or they do not
  and a violation is always real → the rule selection in **§11**.
- [Xebia — Taking Frontend Architecture Serious With Dependency-cruiser](https://xebia.com/blog/taking-frontend-architecture-serious-with-dependency-cruiser/) —
  dependency-cruiser as an architecture fitness function.
- [Jacob Andrewsky — Avoid cross-module dependencies with dependency-cruiser](https://dev.to/jacobandrewsky/avoid-cross-module-dependencies-with-dependency-cruiser-3b0b) —
  the sibling-isolation pattern behind `no-cross-module`.
- [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries) — alternative /
  complement: declare layers, get the violation in-editor rather than in CI.
- [ArchUnitTS](https://lukasniessen.github.io/ArchUnitTS/) — the same rules expressed as vitest
  assertions, if we ever want architecture checks inside `pnpm test`.

## Tier 4 — counterweight (why §12 refuses to over-engineer)

- [Oliver Drotbohm — Sliced Onion Architecture](http://odrotbohm.github.io/2023/07/sliced-onion-architecture/) —
  plain onion treats the domain as *"a single, opaque block"* and lumps every adapter into one
  misleadingly uniform ring; cutting it vertically into modules creates *"natural, low-cost seams"*.
  This is the direct justification for **§9** (vertical slices inside horizontal rings) and for why
  `no-cross-module` exists at all.
- [Jimmy Bogard — Vertical Slice Architecture](https://www.jimmybogard.com/vertical-slice-architecture/) —
  couple along the axis of change, not along technical layers.
- [CSA — Architectures in comparison: Onion or Vertical Slice?](https://www.csa.ch/en/blog/architectures-in-comparison-onion-or-vertical-slice) —
  where each wins; the combination costs some boilerplate and is justified by testability.
- [Mehmet Ozkaya — The Problem with Clean Architecture: Vertical Slices](https://medium.com/design-microservices-architecture-with-patterns/the-problem-with-clean-architecture-vertical-slices-111537c0ffcb) ·
  [Vertical Slice Architecture vs Clean Architecture](https://mehmetozkaya.medium.com/vertical-slice-architecture-and-comparison-with-clean-architecture-76f813e3dab6) —
  the "mock-heavy, rigid rules, anemic domain, pass-through services" critique. Source of **§12**'s
  closing rules: no ring per file, no interface with one implementation and no fake, no hand-written
  domain twin for a row that never crosses a boundary.

---

## Notes on source reliability

- `herbertograca.com` and `blog.ndepend.com` returned **HTTP 403** to automated fetching; they are
  cited from search-result excerpts, not full text. Every rule that depends on them is independently
  supported by a Tier 1 source (Palermo, Cockburn) or by the codebase itself.
- Everything else in Tier 1–4 marked as supplying a specific rule was fetched and read in full.
- `jeffreypalermo.com` part 1 also 403'd on fetch; the dependency-rule statement is taken from the
  Cockburn and Graça formulations, which agree with it.
