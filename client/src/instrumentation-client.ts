/* instrumentation-client.ts — Next.js client instrumentation hook (runs once in
   the browser before the app hydrates). Starts opt-in Sentry monitoring; with an
   empty `NEXT_PUBLIC_SENTRY_DSN` this resolves immediately and loads nothing. */
import { initMonitoring } from "./lib/monitoring/sentry";

void initMonitoring();
