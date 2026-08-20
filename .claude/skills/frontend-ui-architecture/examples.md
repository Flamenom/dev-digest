# Examples — Frontend UI Architecture

Short good/bad pairs on this repo's stack (Next.js 15 App Router · React 19 · TanStack Query ·
inline `styles.ts` + CSS tokens · `next-intl`). Each illustrates a rule from [SKILL.md](./SKILL.md).

---

## 1. Feature/domain organization, not by type

```
❌ Organized by technical type — one feature smeared across four folders
src/
  components/  AgentCard.tsx  ReviewRow.tsx  RepoTree.tsx
  hooks/       useAgents.ts   useReviews.ts  useRepoIntel.ts
  utils/       agentLabel.ts  reviewCost.ts
  types/       agent.ts       review.ts

✅ Organized by feature — everything an agent needs is together
src/app/agents/
  page.tsx                    # thin: composes the feature
  _components/AgentCard/      # UI (colocated styles.ts + constants.ts)
  _components/AgentsListView/
# shared, non-UI: src/lib/hooks/agents.ts · src/lib/model-label.ts
```

Rule: group by *what it does for the user*. Promote to a shared folder only on the 2nd consumer.

---

## 2. Where a component lives — colocate first, promote on 2nd use

```tsx
// ❌ New component dropped in the global bucket "in case we reuse it"
// src/components/AgentStatusPill.tsx  ← only <AgentCard> uses it

// ✅ Route-local until a real 2nd consumer appears
// src/app/agents/_components/AgentCard/AgentStatusPill.tsx
// If a settings page later needs it too → THEN move to src/components/AgentStatusPill/
```

---

## 3. Split a component: thin presentational + logic in a hook

```tsx
// ❌ Container mixes fetching, business rules, and presentation in one body
function AgentsListView() {
  const [agents, setAgents] = useState([]);
  useEffect(() => { apiFetch("/agents").then(setAgents); }, []);      // fetch in body
  const sorted = agents.sort((a, b) => a.name.localeCompare(b.name)); // logic in body
  return <div>{sorted.map(a => <div key={a.id} style={{ padding: 12 }}>{a.name}</div>)}</div>;
}

// ✅ Hook owns data+logic; component is thin and presentational
// lib/hooks/agents.ts
export function useSortedAgents() {
  const { data, ...rest } = useApiQuery(["agents"], "/agents"); // core hook, not raw fetch
  const agents = useMemo(() => sortByName(data ?? []), [data]); // sortByName = pure util
  return { agents, ...rest };
}

// app/agents/_components/AgentsListView/index.tsx
function AgentsListView() {
  const { agents, isLoading, isError } = useSortedAgents();
  if (isLoading) return <Spinner />;
  if (isError) return <ErrorState />;
  return <ul>{agents.map(a => <AgentCard key={a.id} agent={a} />)}</ul>;
}
```

---

## 4. Constants: name magic values, colocate, use CSS tokens

```tsx
// ❌ Magic values inline — un-searchable, un-typed, hardcoded color
<div style={{ gridTemplateColumns: "2fr 1fr 1fr", color: "#8b5cf6" }} />
if (agent.state === "draft") { /* ... */ }

// ✅ Named + colocated; color from a design token
// app/agents/_components/AgentsListView/constants.ts
export const GRID = "2fr 1fr 1fr";
// styles.ts references the token, not a hex literal
export const s = { row: { gridTemplateColumns: GRID, color: "var(--accent)" } };
// domain value as a typed literal union, shared in lib when it crosses features
export const AGENT_STATE = { draft: "draft", active: "active" } as const;
```

---

## 5. utils vs services — keep utils pure, I/O in the service layer

```ts
// ❌ "util" that reaches the network — now it needs mocks to test, imports awkwardly
// lib/agentUtils.ts
export async function getAgentLabel(id: string) {
  const a = await fetch(`/agents/${id}`).then(r => r.json()); // I/O hidden in a "util"
  return a.name.toUpperCase();
}

// ✅ Pure util (no I/O, test without mocks) + service does the fetch
// lib/model-label.ts  — pure
export const formatAgentLabel = (name: string) => name.trim().toUpperCase();
// lib/api.ts  — the service boundary (typed apiFetch / ApiError already here)
export const getAgent = (id: string) => apiFetch<Agent>(`/agents/${id}`);
```

Promotion rule: `formatAgentLabel` starts in the feature; move it to shared `lib/` only when a
second feature imports it.

---

## 6. App Router: push `"use client"` to the leaf

```tsx
// ❌ Whole page is a client component just for one button → entire subtree ships to the client
"use client";
export default function AgentsPage() {
  const { agents } = useSortedAgents();
  return (<><AgentsTable agents={agents} /><RefreshButton /></>);
}

// ✅ Page/shell stay Server Components; only the interactive island is client
// app/agents/page.tsx  (Server Component — no directive, fetches on the server)
export default async function AgentsPage() {
  const agents = await getAgents();
  return (<><AgentsTable agents={agents} /><RefreshButton /></>);
}
// app/agents/_components/RefreshButton.tsx
"use client";
export function RefreshButton() { /* onClick, useState — the only client leaf */ }
```

---

## 7. Route groups: organize without changing the URL

```
✅ Group by area + give each its own layout; URL is unaffected
src/app/
  (marketing)/            # /  , /pricing        → marketing layout.tsx
    page.tsx  pricing/page.tsx  layout.tsx
  (app)/                  # /agents , /repos      → authed app layout.tsx
    agents/page.tsx  repos/page.tsx  layout.tsx
# (marketing) and (app) never appear in the URL — they only organize routes + layouts
```

---

## 8. Features stay independent — compose at the app level

```tsx
// ❌ agents feature imports from the reviews feature → tangled, non-independent
// app/agents/_components/AgentCard/index.tsx
import { ReviewCostBadge } from "../../../reviews/_components/ReviewCostBadge";

// ✅ Shared concern lives in shared; features are composed by the page, not by each other
// components/ReviewCostBadge/  (promoted because 2+ features need it)
// app/agents/page.tsx composes both features side by side; neither imports the other
```
