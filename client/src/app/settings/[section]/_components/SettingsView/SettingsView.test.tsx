import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { MemberList } from "@devdigest/shared";
import settingsMessages from "../../../../../../messages/en/settings.json";
import { renderWithProviders, sessionFor } from "@/test/render-with-providers";
import { SettingsView } from "./SettingsView";

/* Deep link to a google-only section while the session probe is in flight:
   no fallback panel flash — an empty pane until the mode resolves. */

vi.mock("next/navigation", () => ({
  useParams: () => ({ section: "members" }),
  usePathname: () => "/settings/members",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const MEMBERS: MemberList = {
  has_active_admin: true,
  members: [
    {
      user_id: "u-test",
      email: "test@onlytraf.com",
      name: "Test User",
      avatar_url: null,
      role: "admin",
      status: "active",
      joined_at: "2026-10-01T12:00:00.000Z",
      last_sign_in_at: null,
    },
  ],
};

describe("SettingsView", () => {
  it("holds an empty pane for /settings/members while the session is pending, then shows Members", async () => {
    let answerSession: (value: unknown) => void = () => {};
    const sessionProbe = new Promise((resolve) => {
      answerSession = resolve;
    });
    renderWithProviders(<SettingsView />, {
      routes: { "GET /auth/session": () => sessionProbe, "GET /members": MEMBERS },
    });

    // Probe in flight: neither the fallback panel nor the Members section.
    expect(await screen.findByRole("heading", { name: settingsMessages.title })).toBeInTheDocument();
    expect(screen.queryByText(/Standard configuration forms/)).not.toBeInTheDocument();
    expect(screen.queryByText(settingsMessages.members.body)).not.toBeInTheDocument();

    answerSession(sessionFor("admin"));
    expect(await screen.findByText(settingsMessages.members.body)).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /Test User/ })).toBeInTheDocument();
    expect(screen.queryByText(/Standard configuration forms/)).not.toBeInTheDocument();
  });
});
