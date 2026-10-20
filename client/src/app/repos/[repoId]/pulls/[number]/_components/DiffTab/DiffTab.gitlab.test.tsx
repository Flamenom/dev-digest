/* DiffTab × GitLab comment posting (spec 2026-10-20-gitlab-comments): the real
   comment + smart-diff hooks over the shared fetch router — no hook mocks. The
   POST body is asserted from `router.calls`; everything else from the DOM. */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostComment, PrFileHost } from "@/lib/types";
import {
  renderWithProviders,
  apiError,
  type FetchRouter,
  type Routes,
} from "@/test/render-with-providers";
import type { DiffTabHost } from "./DiffTab";
import { DiffTab } from "./DiffTab";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/7",
  useSearchParams: () => new URLSearchParams("tab=diff"),
}));

afterEach(cleanup);

const FILES: PrFileHost[] = [
  {
    path: "src/new-name.ts",
    previous_path: "src/old-name.ts",
    change_type: "renamed",
    additions: 1,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n a\n+export const renamed = true;",
  },
];

const GITLAB_NOTE: HostComment = {
  id: 501,
  path: "src/new-name.ts",
  line: 2,
  original_line: 2,
  side: "RIGHT",
  body: "Why rename?",
  user: "devdigest-bot",
  created_at: "2026-10-20T10:00:00Z",
  html_url: "https://gitlab.com/acme/api/-/merge_requests/7#note_501",
  in_reply_to_id: null,
  is_outdated: false,
  discussion_id: "disc-abc",
  provider: "gitlab",
  devdigest_attribution: { name: "Ann Admin" },
};

const GITLAB_HOST: DiffTabHost = { provider: "gitlab", filesOmittedByHost: 0, postBlocked: null };

/** Comment routes for PR "pr1"; the smart-diff view is irrelevant here (4xx → inline error). */
function commentRoutes(
  comments: () => HostComment[],
  post: Routes[string] = () => apiError(500, "unexpected_post"),
): Routes {
  return {
    "GET /pulls/:id/comments": () => comments(),
    "POST /pulls/:id/comments": post,
    "GET /pulls/:id/smart-diff": apiError(404, "not_found"),
  };
}

function renderTab(routes: Routes, host: DiffTabHost = GITLAB_HOST) {
  return renderWithProviders(
    <>
      <p id="gitlab-token-notice">The GitLab token is invalid.</p>
      <DiffTab prId="pr1" filesCount={FILES.length} files={FILES} canComment host={host} />
    </>,
    { routes },
  );
}

const posts = (router: FetchRouter) =>
  router.calls.filter((c) => c.method === "POST" && c.path === "/pulls/pr1/comments");

/** Original order → hover the added line → "+" → the composer opens. */
async function openComposer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Original order" }));
  // fireEvent for the hover: user-event's pointer moves dispatch `mouseout`
  // with a null relatedTarget, which React reads as leaving the row — the "+"
  // would vanish before the click lands.
  fireEvent.mouseEnter(screen.getByText("export const renamed = true;"));
  await user.click(screen.getByRole("button", { name: "Add a comment on this line" }));
  return {
    textbox: screen.getByRole("textbox"),
    post: screen.getByRole("button", { name: "Comment" }),
  };
}

/** Original order → wait for the routed thread → reveal it. */
async function showThreads(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Original order" }));
  await user.click(await screen.findByRole("button", { name: /Show comments/ }));
}

describe("DiffTab on GitLab (posting enabled)", () => {
  it("AC-14/35/36/37: blank body disables post; one request for two rapid clicks; success reveals comments", async () => {
    let comments: HostComment[] = [GITLAB_NOTE];
    let resolvePost!: (v: unknown) => void;
    const user = userEvent.setup();
    const { router } = renderTab(
      commentRoutes(
        () => comments,
        () => new Promise((r) => (resolvePost = r)),
      ),
    );

    // AC-35/40: no read-only notice anywhere.
    expect(screen.queryByText(/isn't supported yet/)).not.toBeInTheDocument();

    const { textbox, post } = await openComposer(user);
    expect(screen.getByText("Posted to GitLab")).toBeInTheDocument();

    // AC-14: whitespace-only body → disabled; real text → enabled.
    await user.type(textbox, "   ");
    expect(post).toBeDisabled();
    await user.type(textbox, "Please add a test");
    expect(post).toBeEnabled();

    // AC-36: two rapid clicks → exactly one request (button disables in flight).
    await user.click(post);
    await user.click(post);
    expect(post).toBeDisabled();
    await waitFor(() => expect(posts(router)).toHaveLength(1));
    expect(posts(router)[0]!.body).toEqual({
      path: "src/new-name.ts",
      line: 2,
      side: "RIGHT",
      body: "Please add a test",
    });

    // AC-37: success closes the composer and reveals the (hidden) comments,
    // including the just-posted one from the refreshed thread list.
    const created: HostComment = { ...GITLAB_NOTE, id: 502, body: "Please add a test" };
    comments = [GITLAB_NOTE, created];
    resolvePost(created);
    expect(await screen.findByRole("button", { name: /Hide comments/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(await screen.findByText("Please add a test")).toBeInTheDocument();
    expect(posts(router)).toHaveLength(1);
  });

  it("AC-32: a rejected post keeps the draft, shows an inline alert and offers Copy text", async () => {
    const user = userEvent.setup();
    renderTab(
      commentRoutes(
        () => [],
        () =>
          apiError(
            502,
            "gitlab_comment_failed",
            "GitLab didn't confirm the comment — check the MR before posting again.",
          ),
      ),
    );

    const { textbox, post } = await openComposer(user);
    await user.type(textbox, "Consider renaming back");
    await user.click(post);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitLab didn't confirm the comment — check the MR before posting again.",
    );
    // Draft kept, composer still open, focus back in the textarea.
    expect(screen.getByRole("textbox")).toHaveValue("Consider renaming back");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(post).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Copy text" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("Consider renaming back");
  });

  it("AC-25: postBlocked disables post and describes it by the page notice", async () => {
    const user = userEvent.setup();
    const { router } = renderTab(commentRoutes(() => []), {
      ...GITLAB_HOST,
      postBlocked: { describedById: "gitlab-token-notice" },
    });

    const { textbox, post } = await openComposer(user);
    await user.type(textbox, "Draft while blocked");
    expect(post).toBeDisabled();
    expect(post).toHaveAttribute("aria-describedby", "gitlab-token-notice");
    expect(post).toHaveAccessibleDescription("The GitLab token is invalid.");
    await user.click(post);
    expect(screen.getByRole("textbox")).toHaveValue("Draft while blocked");
    expect(posts(router)).toHaveLength(0);
  });

  it("AC-19/35/39: a GitLab thread renders with attribution and replies by discussion_id", async () => {
    const user = userEvent.setup();
    const { router } = renderTab(
      commentRoutes(
        () => [GITLAB_NOTE],
        () => ({ ...GITLAB_NOTE, id: 503, in_reply_to_id: 501, body: "Agreed" }),
      ),
    );

    await showThreads(user);
    expect(screen.getByText("Why rename?")).toBeInTheDocument();
    expect(screen.getByText("via DevDigest · Ann Admin")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByRole("textbox"), "Agreed");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    // The composer closes once the host confirmed the reply.
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(posts(router)).toHaveLength(1);
    const sent = posts(router)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ body: "Agreed", discussion_id: "disc-abc", line: 2 });
    expect(sent).not.toHaveProperty("in_reply_to");
  });

  it("GitHub replies keep in_reply_to", async () => {
    const githubNote: HostComment = {
      ...GITLAB_NOTE,
      discussion_id: null,
      provider: "github",
      devdigest_attribution: null,
    };
    const user = userEvent.setup();
    const { router } = renderTab(
      commentRoutes(
        () => [githubNote],
        () => ({ ...githubNote, id: 504, in_reply_to_id: 501, body: "Ok" }),
      ),
      { provider: "github", filesOmittedByHost: 0, postBlocked: null },
    );

    await showThreads(user);
    expect(screen.getByRole("link", { name: "View on GitHub" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByRole("textbox"), "Ok");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    const sent = posts(router)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ body: "Ok", in_reply_to: 501 });
    expect(sent).not.toHaveProperty("discussion_id");
  });
});
