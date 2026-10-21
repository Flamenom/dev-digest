/* PublishConfirmDialog (AC-38): `!iid`, severity and general counts, the
   other-drafts warning (count 3 / unreadable fallback, never blocking), the
   applicable-suggestions toggle (default off → `apply_suggestions: false`),
   the google-mode note, and a keyboard-only flow (Tab stays inside, Esc
   cancels, focus returns to the trigger). */
import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, apiError, sessionFor } from "@/test/render-with-providers";
import type { Publication } from "@/lib/types";
import { previewEntry, publication } from "../test-fixtures";
import type { SelectedFinding } from "../helpers";
import { PublishConfirmDialog } from "./PublishConfirmDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const GENERAL = { kind: "general", path: "src/b.ts", start_line: 1, end_line: 1, off_diff_reason: "not_on_diff_line" } as const;

const SELECTED: SelectedFinding[] = [
  { entry: previewEntry("11111111-1111-4111-8111-111111111111", { suggestion_eligible: true }), severity: "CRITICAL" },
  { entry: previewEntry("22222222-2222-4222-8222-222222222222", { anchor: GENERAL }), severity: "WARNING" },
  { entry: previewEntry("33333333-3333-4333-8333-333333333333"), severity: "WARNING" },
];

function Harness({ onPublished }: { onPublished: (p: Publication) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Publish 3 to GitLab
      </button>
      {open && (
        <PublishConfirmDialog
          reviewId="rev-1"
          mrIid={7}
          selected={SELECTED}
          onClose={() => setOpen(false)}
          onPublished={(p) => {
            onPublished(p);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe("PublishConfirmDialog", () => {
  it("shows counts and the other-drafts warning, keeps the toggle off, and posts apply_suggestions:false", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    const { router } = renderWithProviders(<Harness onPublished={onPublished} />, {
      routes: {
        "GET /reviews/:id/publish-other-drafts": { other_drafts: 3 },
        "POST /reviews/:id/publications": () => publication(),
      },
    });

    await user.click(screen.getByRole("button", { name: "Publish 3 to GitLab" }));
    const dialog = screen.getByRole("dialog", { name: "Publish to GitLab !7" });
    expect(dialog).toHaveTextContent("1 critical · 2 warning · 0 suggestion");
    expect(dialog).toHaveTextContent("1 finding posts as a general MR comment");
    expect(
      await within(dialog).findByText("3 other draft comments of this account will be published together"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("1 eligible")).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Make code suggestions applicable" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // google mode (default test session) → attribution note.
    expect(dialog).toHaveTextContent("Comments are posted as the GitLab service account and signed with your name");

    const summary = within(dialog).getByLabelText("Summary (optional)");
    await user.type(summary, "Looks good");
    expect(within(dialog).getByText("10 / 10,000")).toBeInTheDocument();
    expect(summary).toHaveAttribute("maxLength", "10000");

    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    const post = router.calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/reviews/rev-1/publications");
    expect(post?.body).toEqual({
      finding_ids: SELECTED.map((f) => f.entry.finding_id),
      summary: "Looks good",
      apply_suggestions: false,
    });
    expect(router.calls.filter((c) => c.path.endsWith("/publish-other-drafts"))).toHaveLength(1);
  });

  it("an unreadable count shows the fallback warning and Publish stays enabled; a rejected publish renders its message", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    renderWithProviders(<Harness onPublished={onPublished} />, {
      session: sessionFor("member", { mode: "local" }),
      routes: {
        "GET /reviews/:id/publish-other-drafts": () => apiError(500, "internal"),
        "POST /reviews/:id/publications": () => apiError(409, "publish_in_progress"),
      },
    });

    await user.click(screen.getByRole("button", { name: "Publish 3 to GitLab" }));
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(
        "Couldn't check for other draft comments of this account — any will be published together",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(dialog).not.toHaveTextContent("Comments are posted as the GitLab service account"),
    );

    const publish = within(dialog).getByRole("button", { name: "Publish" });
    expect(publish).toBeEnabled();
    await user.click(publish);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A publish to this merge request is already in progress.",
    );
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("keyboard only: Tab stays inside the dialog, Esc cancels and focus returns to the trigger", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onPublished={vi.fn()} />, {
      routes: { "GET /reviews/:id/publish-other-drafts": { other_drafts: 0 } },
    });

    const trigger = screen.getByRole("button", { name: "Publish 3 to GitLab" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Count 0 → no warning at all.
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
