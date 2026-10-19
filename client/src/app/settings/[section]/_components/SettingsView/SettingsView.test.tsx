import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import settingsMessages from "../../../../../../messages/en/settings.json";

/* Deep link to a google-only section while the session probe is in flight:
   no fallback panel flash — an empty pane until the mode resolves. */

const perm = vi.hoisted(() => ({ isPending: true }));
vi.mock("next/navigation", () => ({ useParams: () => ({ section: "members" }) }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return {
    ...actual,
    useCan: () =>
      actual.buildPermissions({
        mode: perm.isPending ? null : "google",
        role: perm.isPending ? null : "admin",
        userId: perm.isPending ? null : "u1",
        isPending: perm.isPending,
      }),
  };
});
vi.mock("./_components/SettingsMembers", () => ({ SettingsMembers: () => <div>members panel</div> }));

import { SettingsView } from "./SettingsView";

function renderView() {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages }}>
      <SettingsView />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe("SettingsView", () => {
  it("holds an empty pane for /settings/members while the session is pending, then shows Members", () => {
    perm.isPending = true;
    renderView();
    expect(screen.queryByText(/Standard configuration forms/)).not.toBeInTheDocument();
    expect(screen.queryByText("members panel")).not.toBeInTheDocument();
    cleanup();

    perm.isPending = false;
    renderView();
    expect(screen.getByText("members panel")).toBeInTheDocument();
  });
});
