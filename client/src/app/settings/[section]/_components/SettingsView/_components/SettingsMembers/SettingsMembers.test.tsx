import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CurrentSession, MemberList, Role } from "@devdigest/shared";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import authMessages from "../../../../../../../../messages/en/auth.json";
import { ApiError } from "@/lib/api";

/* AC-19 banner, AC-20 list fields, AC-21/AC-33 (Settings → Members row:
   Admin manages, Member list only), AC-22 `last_admin` inline error. */

let members: MemberList;
const mutate = vi.fn();
let updateState: { isError: boolean; error: unknown } = { isError: false, error: null };

vi.mock("@/lib/hooks", () => ({
  useMembers: () => ({ data: members, isPending: false, isError: false }),
  useUpdateMember: () => ({ mutate, isPending: false, ...updateState }),
}));

import { SettingsMembers } from "./SettingsMembers";

function list(hasAdmin = true): MemberList {
  return {
    has_active_admin: hasAdmin,
    members: [
      {
        user_id: "u1",
        email: "ann@onlytraf.com",
        name: "Ann Admin",
        avatar_url: null,
        role: "admin",
        status: "active",
        joined_at: "2026-10-01T12:00:00.000Z",
        last_sign_in_at: "2026-10-18T12:00:00.000Z",
      },
      {
        user_id: "u2",
        email: "bob@onlytraf.com",
        name: "Bob Member",
        avatar_url: null,
        role: "member",
        status: "deactivated",
        joined_at: "2026-10-02T12:00:00.000Z",
        last_sign_in_at: null,
      },
    ],
  };
}

function renderAs(role: Role, userId = "u1") {
  const session: CurrentSession = {
    mode: "google",
    user: { id: userId, email: "x@onlytraf.com", name: "X", avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
  const qc = new QueryClient();
  qc.setQueryData(["session"], session);
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages, auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <SettingsMembers />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  members = list();
  updateState = { isError: false, error: null };
});
afterEach(() => {
  cleanup();
  mutate.mockReset();
});

describe("SettingsMembers", () => {
  it("Admin: sees every member with all fields and can change role, deactivate and reactivate", () => {
    renderAs("admin");

    const ann = screen.getByRole("row", { name: /Ann Admin/ });
    expect(within(ann).getByText("ann@onlytraf.com")).toBeInTheDocument();
    expect(within(ann).getByText("(you)")).toBeInTheDocument();
    expect(within(ann).getByText("Active")).toBeInTheDocument();
    expect(within(ann).getByText("Oct 1, 2026")).toBeInTheDocument();
    expect(within(ann).getByText("Oct 18, 2026")).toBeInTheDocument();
    const bob = screen.getByRole("row", { name: /Bob Member/ });
    expect(within(bob).getByText("Deactivated")).toBeInTheDocument();
    expect(within(bob).getByText("Never")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.change(within(bob).getByRole("combobox", { name: /Role for Bob Member/ }), {
      target: { value: "admin" },
    });
    expect(mutate).toHaveBeenLastCalledWith({ userId: "u2", patch: { role: "admin" } });

    fireEvent.click(within(bob).getByRole("button", { name: "Reactivate Bob Member" }));
    expect(mutate).toHaveBeenLastCalledWith({ userId: "u2", patch: { status: "active" } });

    fireEvent.click(within(ann).getByRole("button", { name: "Deactivate Ann Admin" }));
    expect(mutate).toHaveBeenLastCalledWith({ userId: "u1", patch: { status: "deactivated" } });
  });

  it("Admin: a `last_admin` rejection is shown inline", () => {
    updateState = { isError: true, error: new ApiError("last admin", 409, "last_admin") };
    renderAs("admin");

    const ann = screen.getByRole("row", { name: /Ann Admin/ });
    expect(within(ann).getByRole("alert")).toHaveTextContent(settingsMessages.members.errors.last_admin);
  });

  it("Member: list only (no role selector or status actions) and the no-admin banner when nobody is Admin", () => {
    members = list(false);
    renderAs("member", "u2");

    expect(screen.getByRole("status")).toHaveTextContent("No admin — set the admin allowlist and sign in");
    expect(screen.getByText("Ann Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@onlytraf.com")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Ann Admin/ })).getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });
});
