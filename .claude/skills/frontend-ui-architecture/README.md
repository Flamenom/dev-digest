# frontend-ui-architecture — sources & rationale

**Version:** 1.0.0
**Scope:** Frontend UI architecture & code organization for React + Next.js App Router.
Structure & maintainability, **not** runtime performance.
**Complements:** [`react-best-practices`](../react-best-practices/SKILL.md) (component/hook micro-rules),
[`next-best-practices`](../next-best-practices/SKILL.md) (file-convention mechanics).

This skill's rules were distilled from a fact-checked deep-research pass
(6 search angles · 21 sources fetched · 99 claims extracted · 25 adversarially verified,
24 confirmed / 1 refuted). Sources below are grouped by trust tier; every rule in
[SKILL.md](./SKILL.md) traces to one of them.

---

## Tier 1 — Primary / authoritative

### Next.js official docs (App Router — verbatim-verified, v16, 2026)
- [Project Structure](https://nextjs.org/docs/app/getting-started/project-structure) — three organization strategies; "pick one, be consistent"
- [Colocation (routing)](https://nextjs.org/docs/app/building-your-application/routing/colocation) — safe colocation; nothing routable until `page.js`/`route.js`
- [Route Groups `(folder)`](https://nextjs.org/docs/app/api-reference/file-conventions/route-groups) — organize without affecting the URL; per-group & multiple root layouts
- [Glossary](https://nextjs.org/docs/app/glossary) — Server Component (default), private folders `_folder`, `"use client"` definitions
- [`use client` directive](https://nextjs.org/docs/app/api-reference/directives/use-client) — server/client boundary; pulls file + imports into the client bundle
- [Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components) — the boundary as a primary architectural axis

### Feature-Sliced Design (formal methodology: layers → slices → segments)
- [Official docs](https://feature-sliced.design/) — layers, slices, segments (`ui`/`model`/`lib`/`api`); unidirectional import rule (enforced by the `steiger` linter)
- [The Perfect Folder Structure for Scalable Frontend](https://feature-sliced.design/blog/frontend-folder-structure) — feature-vs-type; atomic-design contrast; business logic in `model`

### bulletproof-react (~30k★ canonical reference repo)
- [Project Structure docs](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — `features/` folder; `shared → features → app` flow; no cross-feature imports

---

## Tier 2 — Engineering blogs (sub-topics official docs don't cover)

### Component splitting, granularity & composition
- [Kent C. Dodds — State Colocation](https://kentcdodds.com/blog/state-colocation-will-make-your-react-app-faster) — keep state/code close to where it's used
- [Epic React — Soul-Crushing Components](https://www.epicreact.dev/soul-crushing-components) — when to break a component apart
- [Epic React — One React Mistake That's Slowing You Down](https://www.epicreact.dev/one-react-mistake-thats-slowing-you-down) — composition over lifting/prop-drilling
- [Epic React — Compound Components (workshop)](https://www.epicreact.dev/workshops/advanced-react-patterns/compound-components/solution) — compound-component pattern
- [makersden — Guide on React Component Composition](https://makersden.io/blog/guide-on-react-component-composition) — composition (children) vs configuration (data-driven props)

### Folder structure & the promotion rule (feature-local → shared)
- [Robin Wieruch — React Folder Structure Best Practices [2026]](https://www.robinwieruch.de/react-folder-structure/) — utils/hooks/services split; promote to top-level once 2+ features need it
- [profy.dev — React Folder Structure in 5 Steps](https://profy.dev/article/react-folder-structure) — feature-based structure walkthrough

### Business logic layering (hooks / services / pure functions / DI)
- [profy.dev — React Architecture: Business Logic & Dependency Injection](https://profy.dev/article/react-architecture-business-logic-and-dependency-injection) — isolate business logic into an app layer
- [Antony Leme — Business vs Application Logic in ReactJS](https://antonyleme.medium.com/business-vs-application-logic-how-to-separate-and-test-your-reactjs-code-4291d0c983b1) — extract logic into pure functions
- [Felix Gerschau — React Hooks & Separation of Concerns](https://felixgerschau.com/react-hooks-separation-of-concerns/) — custom hooks as the modern container/presentational replacement
- [dev.to (rcrd) — Separating Logic from UI in React](https://dev.to/rcrd/separating-logic-from-ui-in-react-a-comparison-with-angular-services-5en) — custom hooks as the idiomatic seam

### Scalable architecture & App Router colocation in practice
- [Feature-Sliced Design — Scalable React Architecture](https://feature-sliced.design/blog/scalable-react-architecture)
- [next-colocation-template (GitHub)](https://github.com/arhamkhnz/next-colocation-template) — `_components` private-folder colocation demo
- [dharmsy — Next.js 16 App Router Folder Structure](https://www.dharmsy.com/blog/nextjs-16-app-router-folder-structure) — folders as architectural decisions

---

## Verified key findings (confidence: HIGH)

1. Organize by business feature/domain, not technical type; each feature self-contained. — *bulletproof-react, FSD*
2. Unidirectional dependency flow `shared → features → app`; features don't import each other, compose at app level. — *bulletproof-react, FSD*
3. FSD = layers → slices → segments; business logic in the `model` segment, keeping components thin. — *FSD*
4. Next.js is deliberately unopinionated; documents 3 strategies; strongest takeaway is **pick one, be consistent**. — *Next.js docs*
5. Safe colocation in route segments — not routable until `page.js`/`route.js`. — *Next.js docs*
6. Private folders `_folder` opt out of routing — canonical home for route-local code. — *Next.js docs*
7. Route groups `(folder)` organize without affecting the URL; enable per-group/multiple root layouts. — *Next.js docs*
8. Server/Client boundary is a primary architectural axis; Server Components default; push `"use client"` to leaves. — *Next.js docs*

### Refuted / excluded
- ✗ "FSD has a fixed hierarchy including a `processes` layer" — `processes` is **deprecated** in FSD 2.x (verification vote 0-3).

### Known gaps (filled pragmatically from Tier-2 blogs, flagged for future revisions)
- Component granularity / presentational-vs-container / composition — sourced from Kent C. Dodds, Epic React, makersden.
- Constants/enums placement (per-feature vs global) — implied by FSD `consts`/`config` segment and bulletproof-react per-feature; not directly primary-sourced.
- utils vs helpers vs services boundaries + promotion rule — Robin Wieruch + profy.dev DI.
- Reconciling `features/` (bulletproof) + FSD slices with App Router colocation — no single source maps them; SKILL.md gives an opinionated reconciliation for this repo.

---

## Changelog
- **1.0.0** — Initial version. Distilled from deep-research run `wf_22098cfc-354`.
