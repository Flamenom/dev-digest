/* GitLab token health (spec 2026-10-20-gitlab-comments, AC-25): the blocking
   rule of `useGitLabTokenHealth(repo)` and the secrets-status refresh after a
   GitLab write — asserted through what the user sees (the token notice) and
   the requests that reach the shared fetch router, not through cache keys. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RepoWithHost, SecretsStatusWithHealth } from "../types";
import {
  renderWithProviders,
  testRepo,
  apiError,
  type FetchRouter,
} from "@/test/render-with-providers";
import { GitLabTokenNotice, GITLAB_TOKEN_NOTICE_ID } from "@/components/gitlab-token-notice";
import { useGitLabTokenHealth } from "./gitlab-health";
import { useCreatePrComment } from "./reviews";
import { useSecretsStatus, useTestConnection } from "./core";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

type Health = SecretsStatusWithHealth["gitlab_health"];

const GITLAB_REPO = testRepo({ provider: "gitlab", host: "gitlab.com" });
const GITHUB_REPO = testRepo();

const SCOPE_TEXT = /The GitLab token is invalid \(missing the api scope\)/;

function status(gitlab_health: Health): SecretsStatusWithHealth {
  return {
    openai: false,
    anthropic: false,
    openrouter: false,
    github: false,
    gitlab: gitlab_health != null,
    gitlab_health,
  } as SecretsStatusWithHealth;
}

/** Renders what the PR pages render from the hook: the blocking value and the notice. */
function Probe({ repo }: { repo: RepoWithHost }) {
  const blocking = useGitLabTokenHealth(repo);
  const { isSuccess } = useSecretsStatus();
  const comment = useCreatePrComment("pr-1");
  const test = useTestConnection();
  return (
    <>
      <p>{isSuccess ? "status loaded" : "status pending"}</p>
      <p>blocking: {blocking ?? "none"}</p>
      {blocking && <GitLabTokenNotice id={GITLAB_TOKEN_NOTICE_ID} health={blocking} />}
      <button onClick={() => comment.mutate({ path: "a.ts", line: 1, body: "hi" })}>Post</button>
      {comment.isError && <p role="alert">{comment.error.message}</p>}
      <button onClick={() => test.mutate({ provider: "gitlab", key: "glpat-x" })}>Test</button>
      {test.data && <p>tested</p>}
    </>
  );
}

const statusCalls = (router: FetchRouter) =>
  router.calls.filter((c) => c.method === "GET" && c.path === "/settings/secrets-status").length;

describe("useGitLabTokenHealth(repo)", () => {
  it.each<[string, RepoWithHost, Health, string]>([
    ["GitLab repo + insufficient_scope", GITLAB_REPO, "insufficient_scope", "insufficient_scope"],
    ["GitLab repo + invalid", GITLAB_REPO, "invalid", "invalid"],
    ["GitLab repo + ok", GITLAB_REPO, "ok", "none"],
    ["GitLab repo + unchecked", GITLAB_REPO, "unchecked", "none"],
    ["GitLab repo + no token", GITLAB_REPO, null, "none"],
    ["GitHub repo + a bad GitLab token", GITHUB_REPO, "insufficient_scope", "none"],
  ])("%s → blocking: %s", async (_label, repo, health, expected) => {
    renderWithProviders(<Probe repo={repo} />, {
      routes: { "GET /settings/secrets-status": status(health) },
    });
    await screen.findByText("status loaded");
    expect(screen.getByText(`blocking: ${expected}`)).toBeInTheDocument();
    if (expected === "none") expect(screen.queryByRole("note")).not.toBeInTheDocument();
    else expect(screen.getByRole("note")).toHaveAttribute("id", GITLAB_TOKEN_NOTICE_ID);
  });
});

describe("GitLab token health refresh after a write", () => {
  it("a comment rejected for a bad GitLab token re-reads secrets-status and shows the notice; other failures don't", async () => {
    let health: Health = "ok";
    let postFailure = apiError(409, "comment_diff_outdated", "The diff moved on");
    const user = userEvent.setup();
    const { router } = renderWithProviders(<Probe repo={GITLAB_REPO} />, {
      routes: {
        "GET /settings/secrets-status": () => status(health),
        "POST /pulls/:id/comments": () => postFailure,
      },
    });
    await screen.findByText("status loaded");
    expect(statusCalls(router)).toBe(1);

    // A non-token failure: shown inline, token health is NOT re-read.
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The diff moved on");
    expect(statusCalls(router)).toBe(1);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    // The server re-checked the token and rejected the post for its scope.
    health = "insufficient_scope";
    postFailure = apiError(403, "gitlab_token_insufficient_scope", "missing api scope");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("note")).toHaveTextContent(SCOPE_TEXT);
    expect(statusCalls(router)).toBe(2);
    expect(screen.getByText("blocking: insufficient_scope")).toBeInTheDocument();
  });

  it("a failed GitLab connection test re-reads secrets-status and shows the notice", async () => {
    let health: Health = "ok";
    const user = userEvent.setup();
    const { router } = renderWithProviders(<Probe repo={GITLAB_REPO} />, {
      routes: {
        "GET /settings/secrets-status": () => status(health),
        "POST /settings/test-connection": () => {
          health = "invalid";
          return { ok: false, code: "gitlab_token_invalid", message: "rejected by GitLab" };
        },
      },
    });
    await screen.findByText("status loaded");

    await user.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByText("tested");
    expect(await screen.findByRole("note")).toHaveTextContent(/rejected by GitLab/);
    await waitFor(() => expect(statusCalls(router)).toBe(2));
  });
});
