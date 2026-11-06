/* monitoring — opt-in, errors-only browser Sentry. See `sentry.ts` for the policy. */
export { initMonitoring, reportRenderError, setMonitoringUser } from "./sentry";
export { isMonitoringEnabled, readMonitoringConfig } from "./config";
export type { MonitoringConfig } from "./config";
export { scrubEvent, scrubString } from "./scrub";
export { MonitoringUser } from "./MonitoringUser";
