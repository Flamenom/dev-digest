"use client";

import React from "react";

/** Selector for elements a dialog's Tab-cycle may land on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently-open dialogs. Dialogs can nest (e.g. the prompt Modal
 * opens from inside the run-trace Drawer); both register document-level
 * keydown listeners, so only the TOPMOST one may react to Escape/Tab —
 * otherwise one Escape would close every open layer at once.
 */
const dialogStack: symbol[] = [];

/** Body overflow before the FIRST dialog locked it (restored by the last). */
let savedBodyOverflow: string | null = null;

/**
 * Shared dialog behaviour for Modal + Drawer (WAI-ARIA dialog pattern):
 *   - Escape closes the topmost open dialog (when an onClose is provided);
 *   - focus moves into the panel on open and is RESTORED to the trigger on close;
 *   - Tab / Shift+Tab cycle inside the panel (focus trap);
 *   - body scroll is locked while open.
 * Returns the ref to attach to the dialog panel element plus a `mounted` flag:
 * the dialog must render `null` until `mounted` is true, THEN portal to
 * document.body — so the server and the first client render agree (hydration
 * safety) and this hook's effect only runs once the panel is really in the DOM.
 */
export function useDialogBehavior(onClose?: () => void) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // Keep the latest onClose without re-running the mount effect. Written in an
  // effect (never during render): render must stay side-effect free, and a
  // discarded concurrent render must not leave its callback behind.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Hydration gate: false on the server and on the first client render.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    // Before `mounted` the dialog renders null — there is no panel to focus,
    // trap, or stack yet. Runs for real on the post-mount render.
    if (!mounted) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    const previouslyFocused = active instanceof HTMLElement ? active : null;
    const token = Symbol("dialog");
    dialogStack.push(token);
    const isTop = () => dialogStack[dialogStack.length - 1] === token;

    // FOCUSABLE matches by selector, which the type system can't verify —
    // `[tabindex]` also matches SVG/MathML nodes. Narrow to real HTMLElements
    // instead of asserting via the querySelectorAll generic.
    const focusablesIn = (root: HTMLElement): HTMLElement[] =>
      Array.from(root.querySelectorAll(FOCUSABLE)).filter(
        (el): el is HTMLElement => el instanceof HTMLElement,
      );

    // Initial focus: the first focusable control, else the panel itself.
    ((panel ? focusablesIn(panel)[0] : undefined) ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape" && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && panel) {
        const focusables = focusablesIn(panel);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const firstEl = focusables[0]!;
        const lastEl = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        // Focus escaped the panel entirely (e.g. a backdrop click leaves it on
        // <body>) — without this guard the next Tab would land on background
        // page controls behind the aria-modal dialog. Pull it back inside.
        if (!(active instanceof Node) || !panel.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? lastEl : firstEl).focus();
          return;
        }
        if (e.shiftKey && (active === firstEl || active === panel)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Lock body scroll while any dialog is open. The pre-lock value is saved
    // once by the FIRST dialog (a nested dialog would otherwise save "hidden"
    // and re-apply it on close, leaving scroll locked forever).
    if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      const i = dialogStack.indexOf(token);
      if (i !== -1) dialogStack.splice(i, 1);
      document.removeEventListener("keydown", onKeyDown);
      // Only the last dialog to close restores body scroll — a nested dialog
      // closing must not unlock scroll under the still-open parent.
      if (dialogStack.length === 0 && savedBodyOverflow !== null) {
        document.body.style.overflow = savedBodyOverflow;
        savedBodyOverflow = null;
      }
      previouslyFocused?.focus?.();
    };
  }, [mounted]);

  return { panelRef, mounted };
}
