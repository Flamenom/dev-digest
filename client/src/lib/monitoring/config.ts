/* monitoring/config.ts — the web Sentry settings, fixed at BUILD time.

   Next inlines `NEXT_PUBLIC_*` only through a STATIC `process.env.NEXT_PUBLIC_X`
   member access — no destructuring, no computed keys — so each value is read
   with its own literal expression below. An empty DSN means "monitoring off":
   the SDK is never imported and no request goes to any Sentry host (AC-33). */

export interface MonitoringConfig {
  dsn: string;
  environment: string;
  release: string;
}

function orDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function readMonitoringConfig(): MonitoringConfig {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() ?? "",
    environment: orDefault(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT, "production"),
    release: orDefault(process.env.NEXT_PUBLIC_SENTRY_RELEASE, "unknown"),
  };
}

/** True when a DSN was baked into this build. Stable for the page's lifetime. */
export function isMonitoringEnabled(): boolean {
  return readMonitoringConfig().dsn !== "";
}
