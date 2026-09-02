/* Route: /evals — Eval Dashboard overview (screen B, spec §10 B).
   Thin RSC shell (the `conventions/` precedent); everything interactive lives
   in the "use client" leaf below.

   The <Suspense> boundary is load-bearing: the leaf reads the `?case=` deep
   link through `useSearchParams`, and without a boundary the whole route opts
   out of prerendering (next-best-practices → suspense-boundaries). */
import { Suspense } from "react";
import { EvalDashboard } from "./_components/EvalDashboard";

export default function EvalsPage() {
  return (
    <Suspense fallback={null}>
      <EvalDashboard />
    </Suspense>
  );
}
