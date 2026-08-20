import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal dialog behaviour", () => {
  it("labels the dialog with its title and closes on Escape", () => {
    const onClose = vi.fn();
    render(<Modal title="Example Modal" onClose={onClose} />);

    // aria-labelledby wires the visible title to the dialog role.
    expect(screen.getByRole("dialog", { name: "Example Modal" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open and restores it on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(<Modal title="T" onClose={() => {}} />);
    // Initial focus lands on the first focusable control (the Close button).
    expect(document.activeElement).toHaveAttribute("aria-label", "Close");

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("only the topmost dialog reacts to Escape when nested", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Modal title="Outer" onClose={closeOuter} />
        <Modal title="Inner" onClose={closeInner} />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("locks body scroll while open and releases it after the last dialog closes", () => {
    const { unmount } = render(<Modal title="T" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
