import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "./Toggle";
import { IconBtn } from "./IconBtn";
import { Checkbox } from "../kit/Checkbox";

/* aria-disabled on Toggle / IconBtn / Checkbox: the control stays focusable,
   is announced disabled (with a described-by reason), and activation — by
   pointer AND by keyboard (Enter / Space) — is a no-op. Without it, behaviour
   is unchanged. */

function Gallery({ inert, spy }: { inert: boolean; spy: () => void }) {
  return (
    <>
      <span id="why">Admins only</span>
      <Toggle on={false} onChange={spy} label="Enabled" aria-disabled={inert} aria-describedby="why" />
      <IconBtn icon="Edit" label="Edit rule" onClick={spy} aria-disabled={inert} aria-describedby="why" />
      <Checkbox checked={false} onChange={spy} label="Attach" aria-disabled={inert} aria-describedby="why" />
    </>
  );
}

function controls() {
  return [
    screen.getByRole("switch", { name: "Enabled" }),
    screen.getByRole("button", { name: "Edit rule" }),
    screen.getByRole("checkbox", { name: "Attach" }),
  ];
}

describe("aria-disabled primitives", () => {
  it("inert: focusable, announced disabled with the reason, and clicks do nothing", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Gallery inert spy={spy} />);

    for (const control of controls()) {
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toBeDisabled();
      expect(control).toHaveAccessibleDescription("Admins only");
      control.focus();
      expect(control).toHaveFocus();
      await user.click(control);
    }
    // Clicking the Checkbox's visible label must not toggle it either.
    await user.click(screen.getByText("Attach"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("inert: Enter and Space on the focused control do nothing", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Gallery inert spy={spy} />);

    for (const control of controls()) {
      control.focus();
      expect(control).toHaveFocus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("not inert: no aria-disabled and every control fires its handler", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Gallery inert={false} spy={spy} />);

    for (const control of controls()) {
      expect(control).not.toHaveAttribute("aria-disabled");
      await user.click(control);
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, true);
    expect(spy).toHaveBeenNthCalledWith(3, true);
  });

  it("not inert: Enter and Space on the focused control each activate it", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Gallery inert={false} spy={spy} />);

    for (const control of controls()) {
      control.focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
    }
    // 3 controls × (Enter + Space) — proves the inert test above is not vacuous.
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
