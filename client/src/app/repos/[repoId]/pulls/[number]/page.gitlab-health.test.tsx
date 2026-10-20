/* PR page × GitLab token health (spec 2026-10-20-gitlab-comments, AC-25/35):
   the real page, hooks and DiffTab over the shared fetch router. */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrDetailHost, PrListPage, RepoWithHost } from "@/lib/types";
import { renderWithProviders, testRepo, type Routes } from "@/test/render-with-providers";
import { RoleProbe, findRole } from "@/test/role-probe";

vi.mock("next/navigation", () => ({
  useParams: () => ({ repoId: "r1", number: "7" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=diff"),
  usePathname: () => "/repos/r1/pulls/7",
}));
// App chrome (palette, shortcuts, own namespaces) is out of scope — as in every page test.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import PRDetailPage from "./page";

const GITLAB_REPO: RepoWithHost = testRepo({
  full_name: "group/proj",
  owner: "group",
  name: "proj",
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/group/proj",
});

const ADDED_LINE = "export const added = true;";

const PR = {
  id: "pr-uuid-7",
  number: 7,
  title: "Add flag",
  author: "alice",
  branch: "feat/flag",
  base: "main",
  head_sha: "abc123",
  additions: 1,
  deletions: 0,
  files_count: 1,
  status: "open",
  body: null,
  commits: [],
  files: [
    {
      path: "src/flag.ts",
      change_type: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ -1,1 +1,2 @@\n a\n+${ADDED_LINE}`,
    },
  ],
  files_omitted_by_host: 0,
} as unknown as PrDetailHost;

const PAGE: PrListPage = {
  pulls: [PR],
  sync: { trigger: "fresh", state: "idle", last_synced_at: new Date().toISOString() },
};

function routes(health: string | null): Routes {
  return {
    "GET /repos": [GITLAB_REPO],
    "GET /repos/r1/pulls/page": PAGE,
    "GET /pulls/pr-uuid-7": PR,
    "GET /pulls/pr-uuid-7/reviews": [],
    "GET /pulls/pr-uuid-7/comments": [],
    "GET /settings/secrets-status": { gitlab_health: health },
  };
}

/** Diff tab → original order → hover the added line → "+" → the composer. */
async function openComposer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Original order" }));
  // fireEvent for the hover (see DiffTab.gitlab.test.tsx: user-event's
  // pointer moves make React read the row as left before the click lands).
  fireEvent.mouseEnter(screen.getByText(ADDED_LINE));
  await user.click(screen.getByRole("button", { name: "Add a comment on this line" }));
  await user.type(screen.getByRole("textbox"), "Please add a test");
  return screen.getByRole("button", { name: "Comment" });
}

describe("PR page — GitLab token health", () => {
  it("AC-25: insufficient_scope → persistent notice above the tabs; post disabled and described by it", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(
      <>
        <RoleProbe />
        <PRDetailPage />
      </>,
      { session: "member", routes: routes("insufficient_scope"), repoProvider: true },
    );
    await findRole("member");

    const notice = (await screen.findByText(/missing the api scope/)).closest('[role="note"]');
    expect(notice).toHaveAttribute("id", "gitlab-token-notice");
    expect(notice).toHaveTextContent(
      "The GitLab token is invalid (missing the api scope). An admin must save a token with the api scope in Settings → API Keys.",
    );
    expect(notice).toHaveTextContent("Ask an admin to update it.");

    const post = await openComposer(user);
    expect(post).toBeDisabled();
    expect(post).toHaveAttribute("aria-describedby", "gitlab-token-notice");
    await user.click(post);
    expect(router.calls.some((c) => c.method === "POST" && c.path.endsWith("/comments"))).toBe(false);
  });

  it("AC-35: health ok → no token notice, post enabled", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PRDetailPage />, {
      session: "admin",
      routes: routes("ok"),
      repoProvider: true,
    });

    const post = await openComposer(user);
    expect(post).toBeEnabled();
    expect(post).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/The GitLab token is invalid/)).not.toBeInTheDocument();
    expect(document.getElementById("gitlab-token-notice")).toBeNull();
  });
});
