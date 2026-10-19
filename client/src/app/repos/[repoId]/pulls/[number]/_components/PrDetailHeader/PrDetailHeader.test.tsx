import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import prHost from "../../../../../../../../messages/en/prHost.json";
import type { PrDetailHost, RepoWithHost } from "@/lib/types";
import { hostLabelKey, hostPrUrl } from "@/lib/host-urls";
import { PrDetailHeader } from "./PrDetailHeader";

afterEach(cleanup);

const GITLAB_REPO: RepoWithHost = {
  id: "repo-gl",
  owner: "space-profit/platform",
  name: "crm-frontend",
  full_name: "space-profit/platform/crm-frontend",
  default_branch: "main",
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/space-profit/platform/crm-frontend",
  sync_state: "idle",
} as RepoWithHost;

const GITHUB_REPO: RepoWithHost = {
  ...GITLAB_REPO,
  id: "repo-gh",
  owner: "acme",
  name: "payments-api",
  full_name: "acme/payments-api",
  provider: "github",
  host: "github.com",
  web_url: "https://github.com/acme/payments-api",
} as RepoWithHost;

const PR: PrDetailHost = {
  id: "pr-1",
  number: 5,
  title: "Add CRM export",
  author: "dev",
  branch: "feat/export",
  base: "main",
  head_sha: "abc123",
  additions: 3,
  deletions: 1,
  files_count: 1,
  status: "open",
  body: null,
  files: [],
  commits: [],
  is_draft: true,
} as PrDetailHost;

function renderHeader(repo: RepoWithHost, pr: PrDetailHost = PR) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prHost }}>
      <PrDetailHeader
        pr={pr}
        prId={null}
        tab="overview"
        findingsCount={0}
        hostUrl={hostPrUrl(repo, pr.number)}
        provider={hostLabelKey(repo)}
        onSetTab={() => {}}
        onRunStart={() => {}}
        onRunsStarted={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

describe("PrDetailHeader host link", () => {
  it("GitLab: shows #5, Draft and opens the merge-request page via View on GitLab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderHeader(GITLAB_REPO);

    expect(screen.getByText("#5")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View on GitLab" }));
    expect(open).toHaveBeenCalledWith(
      "https://gitlab.com/space-profit/platform/crm-frontend/-/merge_requests/5",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("GitHub: keeps today's PR link and shows no Draft badge for a non-draft PR", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderHeader(GITHUB_REPO, { ...PR, is_draft: undefined });

    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View on GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/payments-api/pull/5",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("an unsafe host URL yields no link: the button is disabled", () => {
    renderHeader({ ...GITLAB_REPO, web_url: "javascript:alert(1)" } as RepoWithHost);
    expect(screen.getByRole("button", { name: "View on GitLab" })).toBeDisabled();
  });
});
