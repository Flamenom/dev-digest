# @devdigest/web — Next.js studio map

The DevDigest UI: repos, PRs, AI reviews, agent authoring. App Router + React 19. :3000

## Local commands
- `pnpm dev` (:3000) · `pnpm test` (vitest + jsdom, fetch mocked — no API/browser) · `pnpm typecheck`
- API base: `NEXT_PUBLIC_API_BASE` (default http://localhost:3001)

## Where things are
- routes: `src/app/**/page.tsx` (thin); feature logic in colocated `_components/<Name>/`
- data layer: `src/lib/api.ts` (only place with `fetch`) → `src/lib/hooks/*` (TanStack Query)
- design system: `src/vendor/ui` (`@devdigest/ui`) · contracts: `src/vendor/shared` (`@devdigest/shared`)
- i18n: `messages/en/<ns>.json` loaded at runtime by `src/i18n/request.ts`
- chrome: `src/components/app-shell`

## Component convention
- Folder per component: `Name/{Name.tsx, index.ts, constants.ts, helpers.ts, styles.ts, _components/, *.test.tsx}`
- `index.ts` barrels named + default. `helpers.ts` = pure fns. `styles.ts` = `CSSProperties` object.

## Conventions (non-default)
- Styling = inline `styles.ts` + CSS tokens (`var(--…)`), NOT Tailwind utility classes.
- Routes keyed by PR **number**; APIs by row **uuid** — detail page resolves number→uuid from the cached list.
- Global query errors toast only on network/5xx; 4xx stays silent (inline empty states).
- Live runs = raw `EventSource` on `/runs/:id/events` (bypasses api.ts + Query); state derived from polling.

## Do-not-touch
- `src/vendor/shared` is the client's OWN vendored copy of contracts — keep in sync with server; don't fork shapes.
- `src/vendor/ui` is the vendored design system — consume via `@devdigest/ui`, don't inline-fork primitives.

## Read when
- **`README.md`** — UI route map + API surface per screen.
- **`../server/README.md`** — for the REST endpoints the hooks call.
- **`../docs/architecture.md`** — for the end-to-end review flow.
- **`INSIGHTS.md`** — before debugging hydration / SSE / number↔uuid issues.
- **`specs/*.md`** — when implementing a lesson screen (skills, eval, blast, memory…).
