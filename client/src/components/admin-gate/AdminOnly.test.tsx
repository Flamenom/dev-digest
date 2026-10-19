import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "@devdigest/ui";
import type { CurrentSession, Role } from "@devdigest/shared";
import authMessages from "../../../messages/en/auth.json";
import { AdminOnly } from "./AdminOnly";
import { HiddenForMember } from "./HiddenForMember";

/* AC-33 primitive: a Member sees the control focusable, aria-disabled and
   described by a VISIBLE "Admins only" hint; destructive actions are hidden.
   An Admin gets everything enabled. */

afterEach(cleanup);

function session(role: Role): CurrentSession {
  return {
    mode: "google",
    user: { id: "u1", email: "a@onlytraf.com", name: "Ann", avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
}

function renderAs(role: Role, onAdd: () => void) {
  const qc = new QueryClient();
  qc.setQueryData(["session"], session(role));
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <AdminOnly>
          {(gate) => (
            <Button {...gate.controlProps} onClick={gate.guard(onAdd)}>
              Add repository
            </Button>
          )}
        </AdminOnly>
        <HiddenForMember>
          <Button>Remove repository</Button>
        </HiddenForMember>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe("AdminOnly / HiddenForMember", () => {
  it("Member: control stays focusable, is aria-disabled with an 'Admins only' description, and does nothing", () => {
    const onAdd = vi.fn();
    renderAs("member", onAdd);

    const add = screen.getByRole("button", { name: "Add repository" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    expect(add).toHaveAccessibleDescription("Admins only");
    expect(screen.getByText("Admins only")).toBeVisible();

    add.focus();
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();

    expect(screen.queryByRole("button", { name: "Remove repository" })).not.toBeInTheDocument();
  });

  it("Admin: control is enabled, has no hint, and the destructive action is shown", () => {
    const onAdd = vi.fn();
    renderAs("admin", onAdd);

    const add = screen.getByRole("button", { name: "Add repository" });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(add).not.toHaveAccessibleDescription();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();

    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove repository" })).toBeInTheDocument();
  });
});
