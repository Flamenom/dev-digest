import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { HostComment } from "@/lib/types";
import prHost from "../../../../messages/en/prHost.json";
import { CommentCard } from "./CommentCard";

afterEach(cleanup);

const BASE: HostComment = {
  id: 1,
  path: "src/a.ts",
  line: 3,
  original_line: 3,
  side: "RIGHT",
  body: "Looks good",
  user: "devdigest-bot",
  created_at: "2026-10-20T10:00:00Z",
  html_url: "https://gitlab.com/acme/api/-/merge_requests/7#note_1",
  in_reply_to_id: null,
  is_outdated: false,
};

function renderCard(c: HostComment, provider: "github" | "gitlab") {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prHost }}>
      <CommentCard c={c} provider={provider} />
    </NextIntlClientProvider>,
  );
}

describe("CommentCard", () => {
  it("AC-39: a GitLab note posted via DevDigest shows the host user, the attribution and a GitLab link", () => {
    renderCard(
      {
        ...BASE,
        provider: "gitlab",
        discussion_id: "d1",
        devdigest_attribution: { name: "<b>Ann</b>" },
      },
      "gitlab",
    );
    expect(screen.getByText("devdigest-bot")).toBeInTheDocument();
    // The attributed name renders as plain text, never markup.
    expect(screen.getByText("via DevDigest · <b>Ann</b>")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on GitLab" })).toHaveAttribute(
      "href",
      BASE.html_url,
    );
  });

  it("a GitHub comment has no attribution and links to GitHub", () => {
    renderCard({ ...BASE, html_url: "https://github.com/acme/api/pull/7#r1" }, "github");
    expect(screen.queryByText(/via DevDigest/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on GitHub" })).toBeInTheDocument();
  });
});
