import { Suspense } from "react";
import { AgentsListView } from "./_components/AgentsListView";

/* Route: /agents (Agents list). Thin route entry — the view, its create modal,
   styles, constants, helpers and i18n are colocated under _components/AgentsListView.

   The <Suspense> boundary is load-bearing: the view reads the `?create=1` deep
   link through `useSearchParams`, and without a boundary the route opts out of
   prerendering (next-best-practices → suspense-boundaries). */
export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsListView />
    </Suspense>
  );
}
