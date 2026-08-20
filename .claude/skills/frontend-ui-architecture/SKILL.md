---
name: frontend-ui-architecture
description: "Frontend UI architecture & code organization for React + Next.js App Router (2025-26). Use when deciding WHERE code should live and HOW to structure it — folder structure, feature-vs-type organization, where a component/constant/util/hook belongs, when to split a component, where business logic goes, and App Router colocation architecture (private folders, route groups, server/client boundary). Structure & maintainability, NOT runtime performance. Complements react-best-practices (component/hook rules) and next-best-practices (file conventions)."
version: 1.0.0
---

# Frontend UI Architecture & Code Organization

Macro-level architecture: **where does each piece of code live, and why.** This skill
answers placement and structure questions. It deliberately does **not** repeat
component/hook micro-rules ([`react-best-practices`](../react-best-practices/SKILL.md))
or Next.js file-convention mechanics ([`next-best-practices`](../next-best-practices/SKILL.md)).

For good/bad code examples on this repo's stack, see [examples.md](./examples.md).
For sources, see [README.md](./README.md).

## Scope

- ✅ Folder structure, feature-vs-type organization, colocation
- ✅ Where a component / constant / util / hook / business-logic function belongs
- ✅ When and how to split a component
- ✅ App Router structural architecture (private folders, route groups, server/client boundary as an architectural seam)
- ❌ Runtime performance (memoization, bundle size, re-renders) → `react-best-practices`
- ❌ Component purity, `useEffect` rules, derived state → `react-best-practices`
- ❌ Metadata, image/font optimization, route-handler mechanics → `next-best-practices`

---

## 1. The one rule everything else follows

**Organize by feature/domain, not by technical type. Keep dependencies unidirectional:
`shared → features → app`.**

- Code you scatter across global `components/`, `hooks/`, `utils/`, `store/` has low cohesion —
  one feature ends up smeared across four folders. Group by *what it does for the user*, not
  *what kind of file it is*.
- Dependencies flow one way. Shared code is used anywhere; a feature imports only from `shared`;
  the app layer composes features. **A feature must not import from another feature** — compose
  them at the app/page level so each feature stays independent.
- Two conventions codify this: **bulletproof-react** (pragmatic `features/<name>/…`) and
  **Feature-Sliced Design / FSD** (formal `layers → slices → segments`, with the `model` segment
  holding business logic). Adopt the *principle*; don't cargo-cult a full methodology into a small app.
- Next.js itself is **unopinionated** about this — it gives you the tools (below), not the policy.
  **Pick one strategy and apply it consistently.** Inconsistency costs more than any single choice.

> This repo's applied choice: **route-local colocation under `app/<route>/_components/`** for
> route-specific UI, **`client/src/components/`** for cross-route shared UI, **`client/src/lib/`**
> for the shared non-UI layer (api, hooks, models). Match it; don't invent a parallel scheme.

---

## 2. Where components live — decision order

Ask these in order; stop at the first "yes".

| Question | Put it in |
|---|---|
| Used by **one route** only? | `app/<route>/_components/` (private folder — see §6) |
| Shared by **2+ routes**, app-specific? | `client/src/components/<Name>/` |
| Generic, design-system primitive (Button, Card, Badge)? | `client/src/components/ui/` (or `vendor/ui`) |
| Belongs to a distinct **feature/domain** with its own api+hooks+types? | a feature folder that owns all of it |

- **Colocation first.** A component starts life next to the route that uses it. Promote it to
  `components/` only when a **second** consumer appears — not before ("might reuse later" is not a consumer).
- **One component per file.** Small private sub-components in the same file are fine; a second
  *exported* component means a second file.
- A component folder groups the component with its **colocated** `styles.ts`, `constants.ts`,
  and local sub-parts — the same-name pattern this repo already uses
  (e.g. `_components/AgentCard/`).

## 3. How to split a component

Split for **cohesion and readability**, not for an arbitrary line count.

**Split when:**
- The JSX has 2+ visually/conceptually distinct regions that change for different reasons.
- A chunk becomes independently **reusable** (extract the moment the second use appears — Wieruch's rule).
- The file mixes **data/business logic** with **presentation** — pull logic into a hook (§7),
  leaving a thin presentational component.
- You're prop-drilling through a wrapper that doesn't use those props — **lift content up** via `children`.

**Don't split when:**
- The "component" would be a `renderX()` factory function returning JSX — that's not a component
  (see `react-best-practices`). Extract a real `<Component/>` or leave it inline.
- The extraction has exactly one caller and adds indirection without clarifying anything — inline it.

**Presentational vs container:** keep the seam, but express it the modern way — a **custom hook**
does the "container" job (data + logic), the component stays presentational. You rarely need a
separate wrapper component just to fetch.

**Composition vs configuration:** need arbitrary JSX inside? **Compose** (`children`, slots,
compound components). Data-driven, finite shape? **Configure** (a typed `items` prop). Don't grow
a dozen boolean props — that's the signal to compose instead.

## 4. Where constants live

| Constant kind | Location |
|---|---|
| Used by one component | top of that file, or its colocated `constants.ts` |
| Shared across a route's components | `app/<route>/_components/constants.ts` (or route-level `constants.ts`) |
| Cross-feature domain values, enums, config | shared `lib/` (this repo: `lib/feature-models.ts`, `lib/model-label.ts`) |

- **No magic values in JSX/logic** — name them. A bare `12`, `"draft"`, or `#8b5cf6` in a
  component is a latent bug and an un-searchable value.
- **Colocate by default, promote on second use** — same rule as components/utils.
- Prefer **`as const` object maps or string-literal unions** over TS `enum` for values that cross
  the wire or need tree-shaking (see `typescript-expert`); reserve `enum` for closed internal sets.
- Design tokens (color/spacing) belong in **CSS variables** (`var(--border)`, `var(--bg-surface)`),
  referenced from `styles.ts` — not hardcoded hex in components.

## 5. utils vs helpers vs services — and the promotion rule

Same behaviour, different **reach and dependencies**. Name by role, don't mix `utils/` and `helpers/`
folders that mean the same thing — pick one word.

| Layer | What goes there | Depends on |
|---|---|---|
| **utils / lib** (pure) | Stateless pure functions: format, parse, map, compute. Framework-free, trivially testable. | nothing (no React, no I/O) |
| **services / api** | I/O boundary: talk to the backend, normalize responses/errors. | fetch/SDK, not React |
| **hooks** | Stateful glue that binds services + React (see §7). | React + services |

- **The promotion rule (Wieruch):** a util/hook/component lives **inside the feature** until a
  **2nd feature** needs it — then it moves up to shared `lib/`. Don't pre-globalize.
- A function that touches the network or the DOM is **not a util** — it's a service. Keep utils pure
  so they stay import-anywhere and test-without-mocks.
- This repo's service layer is `lib/api.ts` (the typed `apiFetch`/`ApiError` client); pure helpers
  are files like `lib/github-urls.ts`, `lib/model-label.ts`. Follow that split.

## 6. Where business logic lives

**Components render; they don't compute.** Keep components thin.

- Extract business logic into **custom hooks** (stateful, React-aware) and **pure functions**
  (stateless). In FSD terms this is the **`model`** segment; in this repo it's `lib/hooks/*` +
  pure `lib/*` helpers.
- **All data fetching lives in hooks**, never in component bodies — build on this repo's
  `useApiQuery`/`useApiMutation` core (`lib/hooks/core.ts`), one hook module per domain
  (`lib/hooks/agents.ts`, `reviews.ts`, `repo-intel.ts`) re-exported via `lib/hooks/index.ts`.
- **Pure business rules** (validation, calculations, formatting, mapping) go in **pure functions**
  that take inputs and return outputs — no React import. They're the easiest thing in the codebase
  to test, so make them carry the logic.
- The component's job shrinks to: call the hook, branch on loading/error/empty/success, render.

## 7. Next.js App Router — structural architecture

The App Router is a set of **structural tools**, not a folder policy. Use them for architecture:

- **Safe colocation.** A route isn't public until `page.js`/`route.js` exists, and only what those
  return ships to the client. So you can freely colocate files inside a route segment without them
  becoming routable. (This is a *routing* guarantee, not a bundling one — an imported module still bundles.)
- **Private folders `_folderName`** opt a folder + subfolders out of routing. This is the canonical
  home for route-local components/utils/constants — `app/<route>/_components/`, `_lib/`, etc.
  It's how you get colocation *and* separation of UI from routing. This repo already uses `_components/`.
- **Route groups `(folderName)`** organize routes by section/team/concern **without touching the URL**,
  and let you give a subtree its own `layout.tsx` (or multiple root layouts). Use them to structure
  `(marketing)` vs `(app)` areas — not to hide segments from the URL by accident.
- **Server/Client boundary is an architectural axis, not a detail.** Server Components are the
  **default** (render on server, fetch data directly, ship zero client JS, no state/browser APIs).
  `"use client"` marks the boundary and pulls that file **plus everything it imports** into the
  client bundle. Architecture consequence: **push `"use client"` down to the leaf/interactive nodes**
  — a client directive high in the tree drags the whole subtree client-side. Keep data-fetching and
  static shells as Server Components; make small interactive islands client.
- **Where does the feature folder go vs `app/`?** Two coherent answers, pick one: (a) keep `app/`
  for routing + thin pages and put feature code in a sibling layer (this repo's `components/` +
  `lib/`); or (b) colocate feature code inside the route segment via `_components/`/`_lib/`.
  This repo does **both by design** — route-local UI colocated under `_components/`, cross-cutting
  logic in `lib/`. Don't add a third pattern.

---

## Where does X go? — quick reference

| You have… | It goes… |
|---|---|
| A component used by one page | `app/<route>/_components/<Name>/` |
| A component used by 2+ pages | `client/src/components/<Name>/` |
| A generic UI primitive | `components/ui/` (or `vendor/ui`) |
| A magic number/string/color in JSX | a named constant (colocated `constants.ts`) or a CSS token |
| A pure format/parse/map function | `lib/<name>.ts` (pure util) — feature-local first |
| A function that calls the backend | the service layer (`lib/api.ts`) |
| Stateful logic + data fetching | a custom hook in `lib/hooks/<domain>.ts` |
| A validation/calculation rule | a pure function, called from the hook |
| Interactive behaviour in an RSC tree | a small `"use client"` leaf component |
| Something two features both need | promote it up to shared `lib/` / `components/` |

**When unsure:** colocate it next to its single consumer, keep the dependency arrow pointing
`shared → feature → app`, and promote only when a real second consumer appears.
