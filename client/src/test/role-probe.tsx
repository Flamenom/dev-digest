/* role-probe.tsx — a visible session-resolved signal for role-gating tests.

   While the session probe is in flight the UI is fail-closed (`isAdmin`
   false, nothing allowed), so a Member test that only asserts ABSENCE / inert
   state passes in the pending window even if Member gating regressed. Render
   `<RoleProbe />` next to the component and `await findRole("member")` BEFORE
   those assertions: the text comes from the real `useCan()` over the routed
   `GET /auth/session`, so it appears only once the role has resolved.

     renderWithProviders(<><RoleProbe /><AgentCard ag={AGENT} /></>, { session: "member" });
     await findRole("member");
     expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument(); */
import React from "react";
import { screen } from "@testing-library/react";
import type { Role } from "@devdigest/shared";
import { useCan } from "@/lib/hooks/permissions";

/** Shows the role the UI currently gates on (`role: pending` until the probe resolves). */
export function RoleProbe() {
  const { role } = useCan();
  return <p>role: {role ?? "pending"}</p>;
}

/** Resolves once the rendered `<RoleProbe />` shows the session resolved to `role`. */
export function findRole(role: Role): Promise<HTMLElement> {
  return screen.findByText(`role: ${role}`);
}
