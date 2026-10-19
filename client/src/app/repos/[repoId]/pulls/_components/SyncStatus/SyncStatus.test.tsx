import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../../../messages/en/prReview.json";
import type { PrListSync } from "@/lib/types";
import { SyncStatus } from "./SyncStatus";
import { syncAge } from "./helpers";

afterEach(cleanup);

function renderStatus(sync: PrListSync | undefined, updating: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <SyncStatus sync={sync} updating={updating} />
    </NextIntlClientProvider>,
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("SyncStatus", () => {
  it("announces Updating… while running and still shows the last successful sync time", () => {
    renderStatus(
      { trigger: "started", state: "running", last_synced_at: minutesAgo(5) },
      true,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Updating…");
    expect(status).toHaveTextContent("Synced 5m ago");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("on failure keeps the time and shows a 'showing data from' notice; never-synced reads 'Never synced'", () => {
    renderStatus(
      {
        trigger: "fresh",
        state: "failed",
        last_synced_at: minutesAgo(120),
        last_sync_error: "GitLab returned 503",
      },
      false,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Synced 2h ago");
    expect(screen.getByRole("status")).not.toHaveTextContent("Updating…");
    expect(screen.getByRole("note")).toHaveTextContent(/showing data from/);
    cleanup();

    renderStatus({ trigger: "fresh", state: "failed", last_synced_at: null }, false);
    expect(screen.getByRole("status")).toHaveTextContent("Never synced");
    expect(screen.getByRole("note")).toHaveTextContent("no synced data yet");
  });

  it("buckets sync age", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(syncAge(null, now)).toBeNull();
    expect(syncAge("2026-10-16T11:59:30Z", now)).toEqual({ unit: "now", count: 0 });
    expect(syncAge("2026-10-16T11:15:00Z", now)).toEqual({ unit: "minutes", count: 45 });
    expect(syncAge("2026-10-14T12:00:00Z", now)).toEqual({ unit: "days", count: 2 });
  });
});
