import React from "react";
import { describe, it, expect } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Convention, ConventionListResponse } from "@devdigest/shared";
import { useConventions } from "@/lib/hooks/conventions";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { ConventionCard } from "./ConventionCard";
import type { EvidenceLinkRepo } from "../../helpers";

function convention(overrides: Partial<Convention> = {}): Convention {
  return {
    id: "c1",
    repo_id: "r1",
    category: "error-handling",
    rule: "Always use async/await instead of .then() chains",
    evidence_path: "src/api/users.ts",
    evidence_snippet: "const user = await db.users.find(id);",
    evidence_start_line: 23,
    evidence_end_line: 31,
    confidence: 0.91,
    status: "pending",
    created_at: "2026-08-19T00:00:00Z",
    ...overrides,
  };
}

const REPO: EvidenceLinkRepo = {
  full_name: "acme/payments-api",
  default_branch: "main",
  provider: "github",
  host: "github.com",
  web_url: "https://github.com/acme/payments-api",
};
const GITLAB_REPO: EvidenceLinkRepo = {
  full_name: "space-profit/platform/crm-frontend",
  default_branch: "main",
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/space-profit/platform/crm-frontend",
};

/** Renders the card from the real conventions query, as the page does — so a
    mutation's effect is visible once the list re-reads. "Re-read" forces a
    fresh server read and counts it, so a test can await a read issued AFTER
    an interaction (a sync point that reflects any write that interaction made). */
function CardFromApi({ repo }: { repo: EvidenceLinkRepo | null }) {
  const { data, refetch } = useConventions("r1");
  const [reads, setReads] = React.useState(0);
  const first = data?.conventions[0];
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void refetch().then(() => setReads((n) => n + 1));
        }}
      >
        Re-read
      </button>
      <output aria-label="server reads">{reads}</output>
      {first ? <ConventionCard convention={first} repoId="r1" repo={repo} /> : null}
    </>
  );
}

/** In-memory conventions API: PATCH applies the patch, the list re-reads it. */
function conventionsApi(initial: Convention) {
  let current = initial;
  return {
    "GET /repos/r1/conventions": (): ConventionListResponse => ({ conventions: [current], stats: null }),
    "PATCH /conventions/:id": (req: RouteRequest) => {
      current = { ...current, ...(req.body as Partial<Convention>) };
      return current;
    },
  };
}

function renderCard(c: Convention, repo: EvidenceLinkRepo | null = REPO, session: "admin" | "member" = "admin") {
  return renderWithProviders(<CardFromApi repo={repo} />, { session, routes: conventionsApi(c) });
}

/** Wait until the session resolved to Admin (the card's controls are live). */
async function findLiveAccept() {
  const accept = await screen.findByRole("button", { name: /Accept/ });
  await waitFor(() => expect(accept).not.toHaveAttribute("aria-disabled"));
  return accept;
}

describe("ConventionCard", () => {
  it("renders rule, category, evidence label, snippet and confidence", async () => {
    renderCard(convention());
    expect(await screen.findByText("Always use async/await instead of .then() chains")).toBeInTheDocument();
    expect(screen.getByText("error-handling")).toBeInTheDocument();
    expect(screen.getByText("src/api/users.ts:23-31")).toBeInTheDocument();
    expect(screen.getByText("const user = await db.users.find(id);")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
  });

  it("links the evidence to GitHub with line anchors; no repo -> no link", async () => {
    renderCard(convention());
    const link = await screen.findByRole("link", { name: "View on GitHub" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/main/src/api/users.ts#L23-L31",
    );
    expect(link).toHaveAttribute("target", "_blank");

    cleanup();
    renderCard(convention({ evidence_start_line: null, evidence_end_line: null }));
    expect(await screen.findByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/main/src/api/users.ts",
    );

    cleanup();
    renderCard(convention(), null);
    expect(await screen.findByText("src/api/users.ts:23-31")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it("labels and links GitLab evidence as View on GitLab", async () => {
    renderCard(convention({ evidence_start_line: 3, evidence_end_line: 5 }), GITLAB_REPO);
    const link = await screen.findByRole("link", { name: "View on GitLab" });
    expect(link).toHaveAttribute(
      "href",
      "https://gitlab.com/space-profit/platform/crm-frontend/-/blob/main/src/api/users.ts#L3-5",
    );
    expect(screen.queryByRole("link", { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it("Accept marks the convention accepted; clicking the active state toggles back to pending", async () => {
    const user = userEvent.setup();
    const { router } = renderCard(convention());
    await user.click(await findLiveAccept());
    expect(await screen.findByRole("button", { name: "Accepted" })).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "accepted" });

    await user.click(screen.getByRole("button", { name: "Accepted" }));
    expect(await screen.findByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("Reject marks the convention rejected", async () => {
    const user = userEvent.setup();
    renderCard(convention());
    await findLiveAccept();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("button", { name: "Rejected" })).toBeInTheDocument();
  });

  it("inline edit saves a trimmed rule", async () => {
    const user = userEvent.setup();
    const { router } = renderCard(convention());
    await findLiveAccept();
    await user.click(screen.getByRole("button", { name: "Edit rule" }));
    const input = screen.getByDisplayValue("Always use async/await instead of .then() chains");
    await user.clear(input);
    await user.type(input, "  Prefer async/await  ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Prefer async/await")).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "PATCH")?.body).toEqual({ rule: "Prefer async/await" });
  });

  it("cancel restores the original rule without saving", async () => {
    const user = userEvent.setup();
    const { router } = renderCard(convention());
    await findLiveAccept();
    await user.click(screen.getByRole("button", { name: "Edit rule" }));
    const input = screen.getByDisplayValue("Always use async/await instead of .then() chains");
    await user.clear(input);
    await user.type(input, "changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Always use async/await instead of .then() chains")).toBeInTheDocument();

    // Sync point: a later write that must be the FIRST PATCH — had Cancel saved,
    // its rule PATCH would already be recorded ahead of this one.
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("button", { name: "Rejected" })).toBeInTheDocument();
    expect(screen.getByText("Always use async/await instead of .then() chains")).toBeInTheDocument();
    expect(router.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ status: "rejected" }]);
  });
});

describe("ConventionCard gating (AC-33)", () => {
  it("Member: Accept / Reject / Edit rule are aria-disabled and inert; one 'Admins only' hint", async () => {
    const user = userEvent.setup();
    const { router } = renderCard(convention(), REPO, "member");
    const accept = await screen.findByRole("button", { name: /Accept/, description: "Admins only" });
    const reject = screen.getByRole("button", { name: /Reject/ });
    expect(reject).toHaveAccessibleDescription("Admins only");
    const edit = screen.getByRole("button", { name: "Edit rule" });
    for (const btn of [accept, reject, edit]) {
      expect(btn).toHaveAttribute("aria-disabled", "true");
      await user.click(btn);
    }
    // Sync point: a fresh server read issued after the clicks — any PATCH they
    // had sent is applied server-side and would show in the re-read card.
    await user.click(screen.getByRole("button", { name: "Re-read" }));
    expect(await screen.findByRole("status", { name: "server reads" })).toHaveTextContent("1");
    expect(screen.getAllByText("Admins only")).toHaveLength(1);
    // Nothing changed: no edit field opened, the status stayed, nothing was sent.
    expect(screen.queryByDisplayValue("Always use async/await instead of .then() chains")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
