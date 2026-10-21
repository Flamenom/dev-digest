/* ReviewRunAccordion — GitLab publish integration (AC-36, AC-39, AC-40).
   GitLab + Member + a publishable preview → per-finding checkboxes and the
   "Publish N to GitLab" button; a reload while a publication runs resumes its
   progress from server state with the selection frozen; `viewer_can_publish:
   false` hides every publish affordance. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FindingRecord, ReviewRecordWithActor } from "@devdigest/shared";
import type { PublishPreview } from "@/lib/types";
import type { HostLinkRepo } from "@/lib/host-urls";
import { renderWithProviders, sessionFor } from "@/test/render-with-providers";
import { FindingHostProvider } from "../FindingCard";
import { previewEntry, publication } from "../PublishFindings/test-fixtures";
import { ReviewRunAccordion } from "./ReviewRunAccordion";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/7",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ repoId: "r1", number: "7" }),
}));

afterEach(cleanup);

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";

function finding(id: string, title: string): FindingRecord {
  return {
    id,
    severity: "WARNING",
    category: "security",
    title,
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    rationale: "Why it matters.",
    suggestion: null,
    confidence: 0.9,
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "rev-1",
    accepted_at: null,
    dismissed_at: null,
  } as FindingRecord;
}

const REVIEW = {
  id: "rev-1",
  pr_id: "pr-1",
  agent_id: "a1",
  agent_name: "Security Reviewer",
  run_id: "run-1",
  kind: "review",
  verdict: "comment",
  summary: "Two issues",
  score: 70,
  model: "m",
  provider: "openrouter",
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: null,
  created_at: "2026-10-21T09:00:00.000Z",
  findings: [finding(F1, "Unchecked input"), finding(F2, "Leaky log")],
} as unknown as ReviewRecordWithActor;

const GITLAB: HostLinkRepo = {
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/acme/payments",
  full_name: "acme/payments",
};

function preview(overrides: Partial<PublishPreview> = {}): PublishPreview {
  return {
    review_id: "rev-1",
    provider: "gitlab",
    mr_iid: 7,
    viewer_can_publish: true,
    blockers: [],
    findings: [previewEntry(F1), previewEntry(F2)],
    ...overrides,
  };
}

function renderAccordion(routes: Record<string, unknown>) {
  return renderWithProviders(
    <FindingHostProvider value={{ repo: GITLAB, offerCopy: true }}>
      <ReviewRunAccordion review={REVIEW} prId="pr-1" defaultOpen publishEnabled />
    </FindingHostProvider>,
    {
      session: sessionFor("member"),
      routes: { "GET /pulls/:id/eval-cases": [], "GET /reviews/:id/publications": [], ...routes },
    },
  );
}

const findingBoxes = () => screen.getAllByRole("checkbox", { name: /^Select (Unchecked input|Leaky log)/ });

describe("ReviewRunAccordion — publish to GitLab", () => {
  it("Member: one checkbox per publishable finding, nothing selected, the button counts the selection", async () => {
    const user = userEvent.setup();
    renderAccordion({ "GET /reviews/:id/publish-preview": preview() });

    const button = await screen.findByRole("button", { name: "Publish 0 to GitLab" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(findingBoxes()).toHaveLength(2);
    findingBoxes().forEach((box) => expect(box).not.toBeChecked());

    await user.click(screen.getByRole("checkbox", { name: /^Select Unchecked input/ }));
    expect(screen.getByRole("button", { name: "Publish 1 to GitLab" })).not.toHaveAttribute("aria-disabled");

    // Clicking the checkbox did not collapse the accordion (it lives in the body).
    expect(screen.getByText("Leaky log")).toBeInTheDocument();
  });

  it("resumes an in-progress publication after a reload and freezes the selection", async () => {
    const running = publication({ id: "pub-1", status: "in_progress", requested: 2, drafted: 1 });
    renderAccordion({
      "GET /reviews/:id/publish-preview": preview({
        blockers: [{ code: "publish_in_progress", message: "A publish is running.", publication_id: "pub-1" }],
      }),
      "GET /reviews/:id/publications": [running],
      "GET /publications/:id": running,
    });

    expect(await screen.findByText("Publishing 1 of 2…")).toBeInTheDocument();
    await waitFor(() => expect(findingBoxes()).toHaveLength(2));
    findingBoxes().forEach((box) => expect(box).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("button", { name: "Publish 0 to GitLab" })).toHaveAttribute("aria-disabled", "true");
  });

  it("viewer_can_publish:false → no checkboxes and no Publish button; findings still render", async () => {
    const { router } = renderAccordion({
      "GET /reviews/:id/publish-preview": preview({ viewer_can_publish: false }),
    });

    await waitFor(() => expect(router.calls.some((c) => c.path.endsWith("/publish-preview"))).toBe(true));
    expect(await screen.findByText("Unchecked input")).toBeInTheDocument();
    // Let the preview resolve before asserting absence.
    await waitFor(() => expect(screen.queryByRole("button", { name: /to GitLab$/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
