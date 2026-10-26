/* PublishConfirmDialog (AC-38): `!iid`, severity and general counts, the
   other-drafts warning (count 3 / unreadable fallback, never blocking), the
   applicable-suggestions toggle (default off → `apply_suggestions: false`),
   the google-mode note, and a keyboard-only flow (Tab stays inside, Esc
   cancels, focus returns to the trigger).
   Outdated runs (spec 2026-10-23, AC-21 – AC-23): the "Outdated review"
   warning from the publish plan (head_moved K of N, head_unknown All N), the
   preview fallback when the plan read fails, `acknowledge_deprecated` sent
   only while the warning is shown, and the 409 → refresh → reconfirm flow. */
import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, apiError, sessionFor } from "@/test/render-with-providers";
import type { Publication, PublishDeprecation, PublishPlan } from "@/lib/types";
import { LIVE_SHA, REVIEWED_SHA, deferredEntry, previewEntry, publication, publishPlan } from "../test-fixtures";
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

const ID = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;

/** Five selected findings of an outdated review (deferred placement, one eligible suggestion). */
const SELECTED_5: SelectedFinding[] = [1, 2, 3, 4, 5].map((n) => ({
  entry: deferredEntry(ID(n), { suggestion_eligible: n === 1 }),
  severity: "WARNING",
}));

/** A non-deprecated plan with the given other-drafts count and placement. */
function basePlan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return { other_drafts: 0, plan_available: true, deprecation: null, placement: { positioned: 2, general: 1 }, ...overrides };
}

function Harness({
  onPublished,
  selected = SELECTED,
  previewDeprecation,
}: {
  onPublished: (p: Publication) => void;
  selected?: SelectedFinding[];
  previewDeprecation?: PublishDeprecation | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Publish {selected.length} to GitLab
      </button>
      {open && (
        <PublishConfirmDialog
          reviewId="rev-1"
          mrIid={7}
          selected={selected}
          previewDeprecation={previewDeprecation}
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
        "GET /reviews/:id/publish-plan": basePlan({ other_drafts: 3 }),
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
      acknowledge_deprecated: false,
    });
    const planCalls = router.calls.filter((c) => c.path.endsWith("/publish-plan"));
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]?.query.get("finding_ids")).toBe([...SELECTED.map((f) => f.entry.finding_id)].sort().join(","));
    expect(within(dialog).queryByText("Outdated review")).not.toBeInTheDocument();
  });

  it("an unreadable count shows the fallback warning and Publish stays enabled; a rejected publish renders its message", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    renderWithProviders(<Harness onPublished={onPublished} />, {
      session: sessionFor("member", { mode: "local" }),
      routes: {
        "GET /reviews/:id/publish-plan": () => apiError(500, "internal"),
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
      routes: { "GET /reviews/:id/publish-plan": basePlan() },
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

  it("plan head_moved, 3 of 5 general: shows the outdated warning and publishes with acknowledge_deprecated:true", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    const { router } = renderWithProviders(<Harness onPublished={onPublished} selected={SELECTED_5} />, {
      routes: {
        "GET /reviews/:id/publish-plan": publishPlan({ placement: { positioned: 2, general: 3 } }),
        "POST /reviews/:id/publications": () => publication(),
      },
    });

    await user.click(screen.getByRole("button", { name: "Publish 5 to GitLab" }));
    const dialog = screen.getByRole("dialog");
    const warning = await within(dialog).findByRole("note", { name: "Outdated review" });
    expect(warning).toHaveTextContent(
      `Reviewed at \`${REVIEWED_SHA.slice(0, 8)}\`, the MR is now at \`${LIVE_SHA.slice(0, 8)}\`. Findings will be published marked as deprecated.`,
    );
    expect(warning).toHaveTextContent("3 of 5 will be posted as general MR comments (not on a diff line)");
    expect(warning).toHaveTextContent("Code suggestions can't be made applicable for an outdated review.");
    expect(within(dialog).queryByRole("switch")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Publish as deprecated" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({
      finding_ids: SELECTED_5.map((f) => f.entry.finding_id),
      apply_suggestions: false,
      acknowledge_deprecated: true,
    });
  });

  it("plan head_unknown → All N; a failed plan read falls back to the preview's deprecation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onPublished={vi.fn()} selected={SELECTED_5} />, {
      routes: {
        "GET /reviews/:id/publish-plan": publishPlan({
          deprecation: { reason: "head_unknown", reviewed_head_sha: null, live_head_sha: LIVE_SHA },
          placement: { positioned: 0, general: 5 },
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "Publish 5 to GitLab" }));
    const warning = await screen.findByRole("note", { name: "Outdated review" });
    expect(warning).toHaveTextContent(
      "The reviewed commit is unknown. All findings will be posted as deprecated general MR comments.",
    );
    expect(warning).toHaveTextContent("All 5 will be posted as general MR comments");
    expect(screen.getByRole("button", { name: "Publish as deprecated" })).toBeEnabled();
    cleanup();

    renderWithProviders(
      <Harness
        onPublished={vi.fn()}
        selected={SELECTED_5}
        previewDeprecation={{ reason: "head_moved", reviewed_head_sha: REVIEWED_SHA }}
      />,
      { routes: { "GET /reviews/:id/publish-plan": () => apiError(500, "internal") } },
    );
    await user.click(screen.getByRole("button", { name: "Publish 5 to GitLab" }));
    const fallback = screen.getByRole("note", { name: "Outdated review" });
    expect(
      await within(fallback).findByText(
        "Couldn't check how findings will be placed — some or all may be posted as general comments.",
      ),
    ).toBeInTheDocument();
    expect(fallback).toHaveTextContent(REVIEWED_SHA.slice(0, 8));
    expect(screen.getByRole("button", { name: "Publish as deprecated" })).toBeInTheDocument();
  });

  it("a 409 review_diff_outdated keeps the dialog open, shows the warning after the refetch and sends again only on a new click", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    let deprecated = false;
    const { router } = renderWithProviders(<Harness onPublished={onPublished} />, {
      routes: {
        "GET /reviews/:id/publish-plan": () => (deprecated ? publishPlan({ placement: { positioned: 2, general: 1 } }) : basePlan()),
        "POST /reviews/:id/publications": () => {
          if (!deprecated) {
            deprecated = true; // the MR moved on: the server now reports the run as outdated
            return apiError(409, "review_diff_outdated", "This review is outdated — confirm publishing its findings as deprecated.");
          }
          return publication();
        },
      },
    });
    const posts = () => router.calls.filter((c) => c.method === "POST");

    await user.click(screen.getByRole("button", { name: "Publish 3 to GitLab" }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(router.calls.some((c) => c.path.endsWith("/publish-plan"))).toBe(true));
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This review is outdated — confirm publishing its findings as deprecated.",
    );
    expect(await within(dialog).findByRole("note", { name: "Outdated review" })).toHaveTextContent(
      "1 of 3 will be posted as general MR comments",
    );
    const confirm = await within(dialog).findByRole("button", { name: "Publish as deprecated" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({ acknowledge_deprecated: false });
    expect(onPublished).not.toHaveBeenCalled();

    await user.click(confirm);
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toMatchObject({ acknowledge_deprecated: true, apply_suggestions: false });
  });
});
