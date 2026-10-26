/* PublishDeprecationNotice (spec 2026-10-23, AC-20): one non-blocking note per
   reason with the exact wording and a "Re-run review" action; Publish stays
   enabled and is described by the notice. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render-with-providers";
import type { PublishDeprecation } from "@/lib/types";
import { REVIEWED_SHA } from "../test-fixtures";
import { PublishToolbar } from "../PublishToolbar";
import { PublishDeprecationNotice, publishDeprecationNoticeId } from "./PublishDeprecationNotice";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const HEAD_MOVED_TEXT =
  "This review ran on `abcdef12`; the MR has changed since. Findings will be published marked as deprecated.";
const HEAD_UNKNOWN_TEXT =
  "This review predates commit tracking. Findings will be published as deprecated general comments.";

function Harness({ deprecation, onRerun, onPublish }: {
  deprecation: PublishDeprecation;
  onRerun: () => void;
  onPublish: () => void;
}) {
  const id = publishDeprecationNoticeId("rev-1");
  return (
    <>
      <PublishDeprecationNotice id={id} deprecation={deprecation} onRerun={onRerun} />
      <PublishToolbar
        state="some"
        count={1}
        publishableCount={2}
        onToggleAll={vi.fn()}
        onPublish={onPublish}
        noticeId={id}
      />
    </>
  );
}

describe("PublishDeprecationNotice", () => {
  it.each([
    ["head_moved", { reason: "head_moved", reviewed_head_sha: REVIEWED_SHA }, HEAD_MOVED_TEXT],
    ["head_unknown", { reason: "head_unknown", reviewed_head_sha: null }, HEAD_UNKNOWN_TEXT],
    ["head_moved with a non-hex SHA", { reason: "head_moved", reviewed_head_sha: "NOT-A-SHA" }, HEAD_UNKNOWN_TEXT],
  ] as const)("%s: exact text, Re-run review, Publish enabled and described by the notice", async (_name, deprecation, text) => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    const onPublish = vi.fn();
    renderWithProviders(<Harness deprecation={deprecation} onRerun={onRerun} onPublish={onPublish} />);

    const note = screen.getByRole("note");
    expect(note).toHaveAttribute("id", "publish-deprecation-rev-1");
    expect(note).toHaveTextContent(text);
    await user.click(within(note).getByRole("button", { name: "Re-run review" }));
    expect(onRerun).toHaveBeenCalledTimes(1);

    const publish = screen.getByRole("button", { name: "Publish 1 to GitLab" });
    expect(publish).not.toHaveAttribute("aria-disabled");
    expect(publish).toHaveAttribute("aria-describedby", "publish-deprecation-rev-1");
    expect(publish).toHaveAccessibleDescription(`${text} Re-run review`);
    await user.click(publish);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("without a re-run handler renders no button", () => {
    renderWithProviders(
      <PublishDeprecationNotice id="n1" deprecation={{ reason: "head_unknown", reviewed_head_sha: null }} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(HEAD_UNKNOWN_TEXT);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
