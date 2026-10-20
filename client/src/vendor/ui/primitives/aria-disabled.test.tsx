import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toggle } from "./Toggle";
import { IconBtn } from "./IconBtn";
import { Checkbox } from "../kit/Checkbox";

/* aria-disabled on Toggle / IconBtn / Checkbox: the control stays focusable,
   is announced disabled (with a described-by reason), and activation is a
   no-op. Without it, behaviour is unchanged. */

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
  it("inert: focusable, announced disabled with the reason, and clicks do nothing", () => {
    const spy = vi.fn();
    render(<Gallery inert spy={spy} />);

    for (const control of controls()) {
      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).not.toBeDisabled();
      expect(control).toHaveAccessibleDescription("Admins only");
      control.focus();
      expect(control).toHaveFocus();
      fireEvent.click(control);
    }
    // Clicking the Checkbox's visible label must not toggle it either.
    fireEvent.click(screen.getByText("Attach"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("not inert: no aria-disabled and every control fires its handler", () => {
    const spy = vi.fn();
    render(<Gallery inert={false} spy={spy} />);

    for (const control of controls()) {
      expect(control).not.toHaveAttribute("aria-disabled");
      fireEvent.click(control);
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, true);
    expect(spy).toHaveBeenNthCalledWith(3, true);
  });
});
