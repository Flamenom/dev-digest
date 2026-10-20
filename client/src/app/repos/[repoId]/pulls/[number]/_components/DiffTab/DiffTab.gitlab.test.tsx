import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { HostComment, PrFileHost } from "@/lib/types";
import type { DiffTabHost } from "./DiffTab";
import prReview from "../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../messages/en/shell.json";
import prHost from "../../../../../../../../messages/en/prHost.json";

// Hook-module mocking (suite pattern, see DiffTab.test.tsx): no QueryClient /
// fetch. `mutateAsync` is the boundary the composer posts through.
const mutateAsync = vi.fn();
let comments: HostComment[] = [];
vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: () => ({ data: comments }),
  useCreatePrComment: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/lib/hooks/smart-diff", () => ({
  usePrSmartDiff: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { DiffTab } from "./DiffTab";

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

beforeEach(() => {
  mutateAsync.mockReset();
  comments = [];
});
afterEach(cleanup);

function renderTab(host: DiffTabHost = GITLAB_HOST) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell, prHost }}>
      <p id="gitlab-token-notice">The GitLab token is invalid.</p>
      <DiffTab prId="pr1" filesCount={FILES.length} files={FILES} canComment host={host} />
    </NextIntlClientProvider>,
  );
}

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

describe("DiffTab on GitLab (posting enabled)", () => {
  it("AC-14/35/36/37: blank body disables post; one request for two rapid clicks; success reveals comments", async () => {
    comments = [GITLAB_NOTE];
    let resolvePost!: (v: unknown) => void;
    mutateAsync.mockImplementation(() => new Promise((r) => (resolvePost = r)));
    const user = userEvent.setup();
    renderTab();

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
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({
      path: "src/new-name.ts",
      line: 2,
      side: "RIGHT",
      body: "Please add a test",
    });
    expect(post).toBeDisabled();

    // AC-37: success closes the composer and reveals the (hidden) comments.
    resolvePost({ ...GITLAB_NOTE, id: 502 });
    expect(await screen.findByRole("button", { name: /Hide comments/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("AC-32: a rejected post keeps the draft, shows an inline alert and offers Copy text", async () => {
    mutateAsync.mockRejectedValue(
      new Error("GitLab didn't confirm the comment — check the MR before posting again."),
    );
    const user = userEvent.setup();
    renderTab();

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
    renderTab({ ...GITLAB_HOST, postBlocked: { describedById: "gitlab-token-notice" } });

    const { textbox, post } = await openComposer(user);
    await user.type(textbox, "Draft while blocked");
    expect(post).toBeDisabled();
    expect(post).toHaveAttribute("aria-describedby", "gitlab-token-notice");
    expect(post).toHaveAccessibleDescription("The GitLab token is invalid.");
    await user.click(post);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("AC-19/35/39: a GitLab thread renders with attribution and replies by discussion_id", async () => {
    comments = [GITLAB_NOTE];
    mutateAsync.mockResolvedValue({ ...GITLAB_NOTE, id: 503, in_reply_to_id: 501 });
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("button", { name: "Original order" }));
    await user.click(screen.getByRole("button", { name: /Show comments/ }));
    expect(screen.getByText("Why rename?")).toBeInTheDocument();
    expect(screen.getByText("via DevDigest · Ann Admin")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByRole("textbox"), "Agreed");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const sent = mutateAsync.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ body: "Agreed", discussion_id: "disc-abc", line: 2 });
    expect(sent).not.toHaveProperty("in_reply_to");
  });

  it("GitHub replies keep in_reply_to", async () => {
    comments = [{ ...GITLAB_NOTE, discussion_id: null, provider: "github", devdigest_attribution: null }];
    mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderTab({ provider: "github", filesOmittedByHost: 0, postBlocked: null });

    await user.click(screen.getByRole("button", { name: "Original order" }));
    await user.click(screen.getByRole("button", { name: /Show comments/ }));
    expect(screen.getByRole("link", { name: "View on GitHub" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByRole("textbox"), "Ok");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    const sent = mutateAsync.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ body: "Ok", in_reply_to: 501 });
    expect(sent).not.toHaveProperty("discussion_id");
  });
});
