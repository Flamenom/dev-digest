/* PublishBlockerNotice (AC-37): one notice with the server message, "Re-run
   review" only for the head-unknown / diff-outdated blockers, and the
   comments-spec token notice (Admin link vs Member text) for token blockers. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render-with-providers";
import { RoleProbe, findRole } from "@/test/role-probe";
import { PublishBlockerNotice } from "./PublishBlockerNotice";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const OUTDATED = "New commits were pushed since this review — re-run the review to publish.";

describe("PublishBlockerNotice", () => {
  it("head-unknown / diff-outdated: the server message and a Re-run review action", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    renderWithProviders(
      <>
        <div data-testid="outdated">
          <PublishBlockerNotice id="n1" blocker={{ code: "review_diff_outdated", message: OUTDATED }} onRerun={onRerun} />
        </div>
        <div data-testid="unknown">
          <PublishBlockerNotice id="n2" blocker={{ code: "review_head_unknown", message: "Predates publish." }} onRerun={onRerun} />
        </div>
      </>,
    );

    const outdated = within(screen.getByTestId("outdated")).getByRole("note");
    expect(outdated).toHaveAttribute("id", "n1");
    expect(outdated).toHaveTextContent(OUTDATED);
    await user.click(within(outdated).getByRole("button", { name: "Re-run review" }));
    expect(onRerun).toHaveBeenCalledTimes(1);

    const unknown = within(screen.getByTestId("unknown")).getByRole("note");
    expect(unknown).toHaveTextContent("Predates publish.");
    expect(within(unknown).getByRole("button", { name: "Re-run review" })).toBeInTheDocument();
  });

  it("other blockers: message only, no Re-run", () => {
    renderWithProviders(
      <PublishBlockerNotice
        id="n3"
        blocker={{ code: "pr_not_open", message: "The merge request is not open." }}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("The merge request is not open.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("token blockers reuse the token notice: Admin gets the settings link, Member the ask-admin text", async () => {
    renderWithProviders(
      <>
        <RoleProbe />
        <PublishBlockerNotice id="n4" blocker={{ code: "gitlab_token_insufficient_scope", message: "scope" }} />
      </>,
      { session: "admin" },
    );
    await findRole("admin");
    const note = screen.getByRole("note");
    expect(note).toHaveAttribute("id", "n4");
    expect(note).toHaveTextContent("missing the api scope");
    expect(screen.getByRole("link", { name: "Open Settings → API Keys" })).toHaveAttribute("href", "/settings/api-keys");
    cleanup();

    renderWithProviders(
      <>
        <RoleProbe />
        <PublishBlockerNotice id="n5" blocker={{ code: "gitlab_token_missing", message: "No GitLab token is configured." }} />
      </>,
      { session: "member" },
    );
    await findRole("member");
    const missing = screen.getByRole("note");
    expect(missing).toHaveAttribute("id", "n5");
    expect(missing).toHaveTextContent("No GitLab token is configured.");
    expect(missing).toHaveTextContent("Ask an admin to update it.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
