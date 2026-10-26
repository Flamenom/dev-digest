/* PublishToolbar + usePublishSelection (AC-36, AC-37): nothing selected
   initially, select-all picks only publishable findings and shows `mixed` for
   a partial selection, the N label follows the selection, a finding that
   stops being publishable drops out, and a blocker keeps the button inert and
   described by the notice. */
import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render-with-providers";
import type { PublishPreviewFinding } from "@/lib/types";
import { previewEntry } from "../test-fixtures";
import { usePublishSelection } from "../usePublishSelection";
import { FindingPublishControl } from "../FindingPublishControl";
import { PublishToolbar } from "./PublishToolbar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const INITIAL: PublishPreviewFinding[] = [
  previewEntry("f1"),
  previewEntry("f2"),
  previewEntry("f3", { publishable: false, reason: "body_too_long" }),
];
/** The same review after f2 was published elsewhere. */
const REFRESHED: PublishPreviewFinding[] = [
  previewEntry("f1"),
  previewEntry("f2", { publishable: false, reason: "already_published" }),
  INITIAL[2]!,
];

function Harness({ onPublish, blockerNoticeId }: { onPublish: (ids: string[]) => void; blockerNoticeId?: string }) {
  const [preview, setPreview] = useState(INITIAL);
  const sel = usePublishSelection(preview);
  return (
    <>
      {blockerNoticeId && <div id={blockerNoticeId}>Review outdated</div>}
      <PublishToolbar
        state={sel.state}
        count={sel.count}
        publishableCount={sel.publishableCount}
        onToggleAll={sel.toggleAll}
        onPublish={() => onPublish(sel.selectedIds)}
        blockerNoticeId={blockerNoticeId}
      />
      {preview.map((entry) => (
        <FindingPublishControl
          key={entry.finding_id}
          entry={entry}
          title={`Finding ${entry.finding_id}`}
          checked={sel.isSelected(entry.finding_id)}
          onToggle={sel.toggle}
        />
      ))}
      <button type="button" onClick={() => setPreview(REFRESHED)}>
        refresh preview
      </button>
    </>
  );
}

describe("PublishToolbar with usePublishSelection", () => {
  it("selects only publishable findings, shows mixed for partial, updates N and prunes unpublishable ones", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    renderWithProviders(<Harness onPublish={onPublish} />);

    const selectAll = screen.getByRole("checkbox", { name: "Select all publishable" });
    const publish = screen.getByRole("button", { name: "Publish 0 to GitLab" });
    // Nothing selected by default; N = 0 → inert.
    expect(selectAll).toHaveAttribute("aria-checked", "false");
    expect(publish).toHaveAttribute("aria-disabled", "true");
    await user.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByText("Too long to post on GitLab")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Select Finding f1/ }));
    expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByRole("button", { name: "Publish 1 to GitLab" })).not.toHaveAttribute("aria-disabled");

    await user.click(selectAll);
    expect(selectAll).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /Select Finding f3/ })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Publish 2 to GitLab" }));
    expect(onPublish).toHaveBeenLastCalledWith(["f1", "f2"]);

    // f2 stops being publishable → it drops out of the selection.
    await user.click(screen.getByRole("button", { name: "refresh preview" }));
    expect(screen.getByRole("button", { name: "Publish 1 to GitLab" })).toBeInTheDocument();
    expect(selectAll).toHaveAttribute("aria-checked", "true");

    await user.click(selectAll);
    expect(selectAll).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Publish 0 to GitLab" })).toBeInTheDocument();
  });

  it("a review-level blocker keeps Publish inert and describes it by the notice", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    renderWithProviders(<Harness onPublish={onPublish} blockerNoticeId="notice-1" />);

    await user.click(screen.getByRole("checkbox", { name: "Select all publishable" }));
    const publish = screen.getByRole("button", { name: "Publish 2 to GitLab" });
    expect(publish).toHaveAttribute("aria-disabled", "true");
    expect(publish).toHaveAttribute("aria-describedby", "notice-1");
    expect(publish).toHaveAccessibleDescription("Review outdated");
    await user.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("a non-blocking notice id keeps Publish enabled; a blocker id wins when both are set", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    const props = { state: "some" as const, count: 1, publishableCount: 2, onToggleAll: vi.fn(), onPublish };
    renderWithProviders(
      <>
        <div id="dep">Outdated review</div>
        <div id="blk">Blocked</div>
        <div data-testid="notice">
          <PublishToolbar {...props} noticeId="dep" />
        </div>
        <div data-testid="both">
          <PublishToolbar {...props} noticeId="dep" blockerNoticeId="blk" />
        </div>
      </>,
    );

    const [enabled, blocked] = screen.getAllByRole("button", { name: "Publish 1 to GitLab" });
    expect(enabled).not.toHaveAttribute("aria-disabled");
    expect(enabled).toHaveAccessibleDescription("Outdated review");
    await user.click(enabled!);
    expect(onPublish).toHaveBeenCalledTimes(1);

    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription("Blocked");
    await user.click(blocked!);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
