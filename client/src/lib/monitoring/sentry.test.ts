import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ErrorEvent } from "@sentry/browser";

/* Opt-in, errors-only browser Sentry (AC-33, AC-35, AC-40). */

const sdk = vi.hoisted(() => ({
  factory: vi.fn(),
  init: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock("@sentry/browser", () => {
  sdk.factory();
  const integration = (name: string) => () => ({ name });
  return {
    init: sdk.init,
    captureException: sdk.captureException,
    setUser: sdk.setUser,
    globalHandlersIntegration: integration("GlobalHandlers"),
    linkedErrorsIntegration: integration("LinkedErrors"),
    dedupeIntegration: integration("Dedupe"),
  };
});

import {
  __resetMonitoringForTests,
  initMonitoring,
  reportRenderError,
  setMonitoringUser,
} from "./sentry";
import { ApiError } from "../api";

type InitOptions = {
  integrations: Array<{ name: string }>;
  beforeSend: (e: ErrorEvent, h: { originalException?: unknown }) => ErrorEvent | null;
  [key: string]: unknown;
};

function initOptions(): InitOptions {
  return sdk.init.mock.calls[0]![0] as InitOptions;
}

beforeEach(() => {
  __resetMonitoringForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initMonitoring", () => {
  it("with an empty DSN never loads the SDK and every call is a no-op", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");

    await expect(initMonitoring()).resolves.toBe(false);
    reportRenderError(new Error("boom"));
    setMonitoringUser("u-1");

    expect(sdk.factory).not.toHaveBeenCalled();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("with a DSN inits errors-only, tags release/env, and reports render errors", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/1");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_RELEASE", "abc123def456");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "");
    setMonitoringUser("u-7"); // before init → applied once the SDK is up

    await expect(initMonitoring()).resolves.toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);

    const opts = initOptions();
    expect(opts).toMatchObject({
      dsn: "https://key@o1.ingest.sentry.io/1",
      release: "abc123def456",
      environment: "production",
      defaultIntegrations: false,
      maxBreadcrumbs: 0,
    });
    for (const key of [
      "tracesSampleRate",
      "tracesSampler",
      "profilesSampleRate",
      "replaysSessionSampleRate",
      "replaysOnErrorSampleRate",
    ]) {
      expect(opts[key] ?? 0, key).toBe(0);
    }
    const names = opts.integrations.map((i) => i.name);
    expect(names).toEqual(["GlobalHandlers", "LinkedErrors", "Dedupe"]);
    expect(names.some((n) => /replay|tracing/i.test(n))).toBe(false);
    expect(sdk.setUser).toHaveBeenCalledWith({ id: "u-7" });

    const err = new Error("render failed");
    reportRenderError(err);
    expect(sdk.captureException).toHaveBeenCalledWith(err);

    setMonitoringUser(null);
    expect(sdk.setUser).toHaveBeenLastCalledWith(null);
  });

  it("beforeSend drops ApiError events and scrubs everything else", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/1");
    await initMonitoring();
    const { beforeSend } = initOptions();

    const apiEvent = { message: "Internal" } as ErrorEvent;
    expect(beforeSend(apiEvent, { originalException: new ApiError("Internal", 500) })).toBeNull();
    // Matched by shape, not instanceof (duplicate class instances).
    expect(beforeSend(apiEvent, { originalException: { name: "ApiError" } })).toBeNull();

    const leaky = {
      message: "failed with Bearer ddg_pat_CANARYsecret0123456789",
      user: { id: "u-1", email: "ann@example.com" },
      breadcrumbs: [{ message: "x" }],
    } as unknown as ErrorEvent;
    const out = beforeSend(leaky, { originalException: new Error("plain") });
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain("CANARYsecret");
    expect(out!.user).toEqual({ id: "u-1" });
    expect(out!.breadcrumbs).toEqual([]);
  });
});
