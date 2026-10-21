/* PublishProgress (AC-39): the polite "Publishing k of N…" region and the
   result view per outcome, with role="status" for results and role="alert"
   for failures; the MR link is rendered only for an http/https URL. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render-with-providers";
import { publication } from "../test-fixtures";
import { PublishProgress } from "./PublishProgress";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const MR = "https://gitlab.com/acme/api/-/merge_requests/7";

describe("PublishProgress", () => {
  it("in progress and published: polite progress, then a status with the count, other drafts and the MR link", () => {
    renderWithProviders(
      <>
        <div data-testid="running">
          <PublishProgress publication={publication({ requested: 3, drafted: 1, failed: 1 })} mrUrl={MR} />
        </div>
        <div data-testid="done">
          <PublishProgress
            publication={publication({ status: "published", requested: 3, published: 3, other_drafts_published: 2 })}
            mrUrl={MR}
          />
        </div>
      </>,
    );

    const running = within(screen.getByTestId("running")).getByRole("status");
    expect(running).toHaveAttribute("aria-live", "polite");
    expect(running).toHaveTextContent("Publishing 2 of 3…");

    const done = within(screen.getByTestId("done")).getByRole("status");
    expect(done).toHaveTextContent("Published 3 findings to GitLab");
    expect(done).toHaveTextContent("2 other draft comments of this account were published with them");
    const link = within(done).getByRole("link", { name: "View merge request" });
    expect(link).toHaveAttribute("href", MR);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("partially published: counts in a status, each failed finding with its reason in an alert", () => {
    renderWithProviders(
      <PublishProgress
        publication={publication({
          status: "partially_published",
          requested: 2,
          published: 1,
          failed: 1,
          items: [
            { finding_id: "f1", state: "published", code: null, link: null },
            { finding_id: "f2", state: "failed", code: "gitlab_position_rejected", link: null },
          ],
        })}
        findingTitle={(id) => (id === "f2" ? "SQL injection" : undefined)}
      />,
    );

    expect(screen.getByText("Published 1, failed 1").closest('[role="status"]')).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("listitem")).toHaveTextContent(
      "SQL injection — GitLab rejected the comment position.",
    );
  });

  it("failed offers Try again; unconfirmed offers Check GitLab; an unsafe MR URL renders no link", async () => {
    const user = userEvent.setup();
    const onTryAgain = vi.fn();
    renderWithProviders(
      <>
        <div data-testid="failed">
          <PublishProgress
            publication={publication({ status: "failed", code: "gitlab_rate_limited" })}
            mrUrl={MR}
            onTryAgain={onTryAgain}
          />
        </div>
        <div data-testid="unconfirmed">
          <PublishProgress publication={publication({ status: "unconfirmed", code: "gitlab_publish_unconfirmed" })} mrUrl={MR} />
        </div>
        <div data-testid="unsafe">
          <PublishProgress publication={publication({ status: "unconfirmed" })} mrUrl="javascript:alert(1)" />
        </div>
      </>,
    );

    const failed = within(screen.getByTestId("failed")).getByRole("alert");
    expect(failed).toHaveTextContent("GitLab rate-limited the publish. Nothing was published — try again later.");
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(within(failed).queryByRole("link")).not.toBeInTheDocument();

    const unconfirmed = within(screen.getByTestId("unconfirmed")).getByRole("alert");
    expect(unconfirmed).toHaveTextContent("GitLab didn't confirm the publish — check the MR before publishing again.");
    expect(within(unconfirmed).getByRole("link", { name: "Check GitLab" })).toHaveAttribute("href", MR);

    const unsafe = within(screen.getByTestId("unsafe")).getByRole("alert");
    expect(unsafe).toHaveTextContent("GitLab didn't confirm the publish");
    expect(within(unsafe).queryByRole("link")).not.toBeInTheDocument();
  });
});
