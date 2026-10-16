/* Route: /evals/:agentId — screen C of the L06 eval pipeline
   (`specs/06-eval-pipeline.md` §10 C, §8.3).

   Thin server shell: Next 15 hands `params` as a Promise, so it is awaited here
   and the resolved `agentId` is passed down as a plain prop — the client leaf
   never needs `useParams`. The `<Suspense>` boundary is required because that
   leaf reads `?days=` through `useSearchParams`; without a boundary the whole
   route would bail out to client-side rendering. */
import { Suspense } from "react";
import { AgentEvalDashboard } from "./_components/AgentEvalDashboard";

export default async function AgentEvalDashboardPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return (
    <Suspense fallback={null}>
      <AgentEvalDashboard agentId={agentId} />
    </Suspense>
  );
}
