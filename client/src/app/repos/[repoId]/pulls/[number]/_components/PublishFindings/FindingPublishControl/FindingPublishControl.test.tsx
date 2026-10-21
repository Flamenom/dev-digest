/* FindingPublishControl (AC-36): reason text for unpublishable findings, the
   off-diff label, and the published state with a safe-only GitLab link. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render-with-providers";
import { previewEntry } from "../test-fixtures";
import { FindingPublishControl } from "./FindingPublishControl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const PUBLISHED = {
  discussion_id: "d1",
  note_id: 9,
  url: "https://gitlab.com/acme/api/-/merge_requests/7#note_9",
  published_at: "2026-10-21T10:00:00.000Z",
  published_by: { id: "u1", name: "Ann Admin" },
  publication_id: "pub-1",
};

describe("FindingPublishControl", () => {
  it("publishable off-diff finding: labelled checkbox toggles and shows the general-comment label", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(
      <FindingPublishControl
        entry={previewEntry("f1", {
          anchor: { kind: "general", path: "src/a.ts", start_line: 3, end_line: 5, off_diff_reason: "not_on_diff_line" },
        })}
        title="Null deref"
        checked={false}
        onToggle={onToggle}
      />,
    );

    const box = screen.getByRole("checkbox", { name: "Select Null deref (src/a.ts:3–5)" });
    expect(box).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Posts as a general MR comment (not on a changed line)")).toBeInTheDocument();
    await user.click(box);
    expect(onToggle).toHaveBeenCalledWith("f1");
  });

  it("unpublishable finding: inert checkbox described by the visible reason; frozen selection ignores clicks", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(
      <>
        <FindingPublishControl
          entry={previewEntry("f2", { publishable: false, reason: "dismissed" })}
          title="Style nit"
          checked={false}
          onToggle={onToggle}
        />
        <FindingPublishControl entry={previewEntry("f3")} title="Bug" checked onToggle={onToggle} disabled />
      </>,
    );

    const box = screen.getByRole("checkbox", { name: /Select Style nit/ });
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).toHaveAccessibleDescription("Dismissed — un-dismiss it to publish");
    expect(screen.getByText("Dismissed — un-dismiss it to publish")).toBeVisible();
    await user.click(box);

    const frozen = screen.getByRole("checkbox", { name: /Select Bug/ });
    expect(frozen).toHaveAttribute("aria-checked", "true");
    await user.click(frozen);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("published finding: attribution + safe link in a new tab; javascript: or null URL renders no link", () => {
    renderWithProviders(
      <>
        <div data-testid="safe">
          <FindingPublishControl entry={previewEntry("f4", { publishable: false, reason: "already_published", published: PUBLISHED })} title="Bug" checked={false} onToggle={vi.fn()} />
        </div>
        <div data-testid="js">
          <FindingPublishControl entry={previewEntry("f5", { published: { ...PUBLISHED, url: "javascript:alert(1)" } })} title="Bug" checked={false} onToggle={vi.fn()} />
        </div>
        <div data-testid="none">
          <FindingPublishControl entry={previewEntry("f6", { published: { ...PUBLISHED, url: null } })} title="Bug" checked={false} onToggle={vi.fn()} />
        </div>
      </>,
    );

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const safe = within(screen.getByTestId("safe"));
    expect(safe.getByText(/^Published by Ann Admin · /)).toBeInTheDocument();
    const link = safe.getByRole("link", { name: "View on GitLab" });
    expect(link).toHaveAttribute("href", PUBLISHED.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    for (const id of ["js", "none"]) {
      const scope = within(screen.getByTestId(id));
      expect(scope.queryByRole("link")).not.toBeInTheDocument();
      expect(scope.getByText("Published — link unavailable")).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
