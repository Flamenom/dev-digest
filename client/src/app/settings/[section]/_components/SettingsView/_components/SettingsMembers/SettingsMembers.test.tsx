import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Member, MemberList } from "@devdigest/shared";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import { apiError, renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { SettingsMembers } from "./SettingsMembers";

/* AC-19 banner, AC-20 list fields, AC-21/AC-33 (Settings → Members row:
   Admin manages, Member list only), AC-22 `last_admin` inline error — the ONLY
   error channel for the update (no global toast on top of it). */

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

/** A tiny in-memory members API: PATCH applies the patch and the list re-reads it. */
function membersApi(initial: MemberList) {
  let state = initial;
  return {
    "GET /members": () => state,
    "PATCH /members/:userId": (req: RouteRequest) => {
      const patch = req.body as Partial<Member>;
      state = {
        ...state,
        members: state.members.map((m) => (m.user_id === req.params.userId ? { ...m, ...patch } : m)),
      };
      return state.members.find((m) => m.user_id === req.params.userId);
    },
  };
}

function sessionAs(role: "admin" | "member", userId: string) {
  return {
    mode: "google" as const,
    user: { id: userId, email: "x@onlytraf.com", name: "X", avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
}

describe("SettingsMembers", () => {
  it("Admin: sees every member with all fields and can change role, deactivate and reactivate", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<SettingsMembers />, {
      session: sessionAs("admin", "u1"),
      routes: membersApi(list()),
    });

    const ann = await screen.findByRole("row", { name: /Ann Admin/ });
    expect(within(ann).getByText("ann@onlytraf.com")).toBeInTheDocument();
    expect(await within(ann).findByText("(you)")).toBeInTheDocument();
    expect(within(ann).getByText("Active")).toBeInTheDocument();
    expect(within(ann).getByText("Oct 1, 2026")).toBeInTheDocument();
    expect(within(ann).getByText("Oct 18, 2026")).toBeInTheDocument();
    const bob = screen.getByRole("row", { name: /Bob Member/ });
    expect(within(bob).getByText("Deactivated")).toBeInTheDocument();
    expect(within(bob).getByText("Never")).toBeInTheDocument();
    expect(screen.queryByText(settingsMessages.members.noAdmin)).not.toBeInTheDocument();

    await user.selectOptions(await within(bob).findByRole("combobox", { name: /Role for Bob Member/ }), "admin");
    await waitFor(() =>
      expect(within(screen.getByRole("row", { name: /Bob Member/ })).getByRole("combobox")).toHaveValue("admin"),
    );
    expect(router.calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "admin" });

    await user.click(within(bob).getByRole("button", { name: "Reactivate Bob Member" }));
    expect(
      await within(screen.getByRole("row", { name: /Bob Member/ })).findByRole("button", {
        name: "Deactivate Bob Member",
      }),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Bob Member/ })).getByText("Active")).toBeInTheDocument();
  });

  it("Admin: a role value outside the Role enum is never sent", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<SettingsMembers />, {
      session: sessionAs("admin", "u1"),
      routes: membersApi(list()),
    });

    const bob = await screen.findByRole("row", { name: /Bob Member/ });
    const select = await within(bob).findByRole("combobox", { name: /Role for Bob Member/ });
    // Inject a forged option so the DOM can actually carry the bogus value.
    const forged = document.createElement("option");
    forged.value = "owner";
    select.appendChild(forged);
    await user.selectOptions(select, "owner");

    // Sync point: a valid role change made AFTER the forged one must be the
    // FIRST PATCH — had "owner" been sent, it would already be recorded ahead.
    await user.selectOptions(select, "admin");
    await waitFor(() =>
      expect(within(screen.getByRole("row", { name: /Bob Member/ })).getByRole("combobox")).toHaveValue("admin"),
    );
    expect(router.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ role: "admin" }]);
  });

  it("Admin: a `last_admin` rejection is shown inline only — no global toast", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsMembers />, {
      session: sessionAs("admin", "u1"),
      routes: {
        "GET /members": list(),
        "PATCH /members/:userId": () => apiError(409, "last_admin", "Cannot remove the last admin"),
      },
    });

    const ann = await screen.findByRole("row", { name: /Ann Admin/ });
    await user.click(await within(ann).findByRole("button", { name: "Deactivate Ann Admin" }));

    expect(await within(ann).findByRole("alert")).toHaveTextContent(settingsMessages.members.errors.last_admin);
    expect(screen.queryByText("Cannot remove the last admin")).not.toBeInTheDocument();
  });

  it("Member: list only (no role selector or status actions) and the no-admin banner when nobody is Admin", async () => {
    renderWithProviders(<SettingsMembers />, {
      session: sessionAs("member", "u2"),
      routes: { "GET /members": list(false) },
    });

    expect(await screen.findByText(settingsMessages.members.noAdmin)).toBeInTheDocument();
    expect(screen.getByText("Ann Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@onlytraf.com")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Ann Admin/ })).getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });
});
