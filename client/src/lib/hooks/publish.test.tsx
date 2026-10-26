/* Publish-findings data layer (spec 2026-10-21-gitlab-publish-findings,
   AC-3/AC-38/AC-39): polling while in progress, the terminal refresh of the
   preview, the other-drafts fallback and the GitHub "no request" rule —
   asserted through rendered output and the requests that reach the router. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishErrorCode } from "@devdigest/shared";
import type { Publication, PublishPreview } from "../types";
import { renderWithProviders, apiError, testMessages } from "@/test/render-with-providers";
import {
  PUBLICATION_POLL_MS,
  useCreatePublication,
  useOtherDraftsCount,
  usePublication,
  usePublishPlan,
  usePublishPreview,
} from "./publish";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls/1",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub-1",
    review_id: "rev-1",
    pr_id: "pr-1",
    status: "in_progress",
    code: null,
    message: null,
    requested: 2,
    drafted: 1,
    published: 0,
    failed: 0,
    general_notes: 0,
    other_drafts_published: 0,
    has_summary: false,
    apply_suggestions: false,
    created_by: null,
    created_at: "2026-10-21T10:00:00.000Z",
    finished_at: null,
    items: [],
    ...overrides,
  };
}

const PREVIEW: PublishPreview = {
  review_id: "rev-1",
  provider: "gitlab",
  mr_iid: 7,
  viewer_can_publish: true,
  blockers: [],
  findings: [],
};

function PublicationProbe() {
  const { data } = usePublication("pub-1");
  return <p>{data ? `status ${data.status}` : "loading"}</p>;
}

function PreviewProbe({ enabled }: { enabled: boolean }) {
  const { data, fetchStatus } = usePublishPreview("rev-1", { enabled });
  return <p>{data ? `preview ${data.mr_iid}` : `preview ${fetchStatus}`}</p>;
}

function OtherDraftsProbe() {
  const { data, isError } = useOtherDraftsCount("rev-1");
  if (isError) return <p>other drafts error</p>;
  if (!data) return <p>other drafts loading</p>;
  return <p>{data.other_drafts === null ? "other drafts unknown" : `other drafts ${data.other_drafts}`}</p>;
}

function PlanProbe({ ids }: { ids: string[] }) {
  const { data, isError } = usePublishPlan("rev-1", ids);
  if (isError) return <p>plan error</p>;
  if (!data) return <p>plan loading</p>;
  if (!data.plan_available) return <p>{`plan unavailable ${data.other_drafts} ${data.placement}`}</p>;
  return <p>{`plan general ${data.placement?.general} of ${(data.placement?.general ?? 0) + (data.placement?.positioned ?? 0)}`}</p>;
}

function PublishProbe() {
  usePublishPreview("rev-1");
  usePublishPlan("rev-1", [ID_A]);
  const create = useCreatePublication("rev-1");
  return (
    <>
      <button
        type="button"
        onClick={() => create.mutate({ finding_ids: [ID_A], acknowledge_deprecated: false })}
      >
        publish
      </button>
      <p>{create.isError ? `publish failed ${(create.error as { code?: string }).code}` : "publish idle"}</p>
    </>
  );
}

describe("publish hooks", () => {
  it("polls a publication while in progress, stops when published and refreshes the preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses: Publication["status"][] = ["in_progress", "in_progress", "published"];
    let reads = 0;
    const { router } = renderWithProviders(
      <>
        <PublicationProbe />
        <PreviewProbe enabled />
      </>,
      {
        routes: {
          "GET /publications/:id": () =>
            publication({ status: statuses[Math.min(reads++, statuses.length - 1)] }),
          "GET /reviews/:id/publish-preview": PREVIEW,
        },
      },
    );

    expect(await screen.findByText("status in_progress")).toBeInTheDocument();
    expect(await screen.findByText("preview 7")).toBeInTheDocument();
    const previewReads = () =>
      router.calls.filter((c) => c.path === "/reviews/rev-1/publish-preview").length;
    expect(previewReads()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(PUBLICATION_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(PUBLICATION_POLL_MS));
    expect(await screen.findByText("status published")).toBeInTheDocument();
    // The terminal transition re-reads the preview (finding states + links).
    await waitFor(() => expect(previewReads()).toBe(2));

    const readsAtTerminal = reads;
    await act(() => vi.advanceTimersByTimeAsync(PUBLICATION_POLL_MS * 3));
    expect(reads).toBe(readsAtTerminal);
  });

  it("maps a failed other-drafts read to null without a toast", async () => {
    const { router } = renderWithProviders(<OtherDraftsProbe />, {
      routes: {
        "GET /reviews/:id/publish-other-drafts": () => apiError(500, "internal", "GitLab is down"),
      },
    });

    expect(await screen.findByText("other drafts unknown")).toBeInTheDocument();
    expect(screen.queryByText("GitLab is down")).not.toBeInTheDocument();
    // Never retried.
    expect(router.calls.filter((c) => c.path === "/reviews/rev-1/publish-other-drafts")).toHaveLength(1);
  });

  it("reads the publish plan with the sorted, comma-joined selection", async () => {
    const { router } = renderWithProviders(<PlanProbe ids={[ID_B, ID_A]} />, {
      routes: {
        "GET /reviews/:id/publish-plan": () => ({
          other_drafts: 0,
          plan_available: true,
          deprecation: null,
          placement: { positioned: 1, general: 1 },
        }),
      },
    });

    expect(await screen.findByText("plan general 1 of 2")).toBeInTheDocument();
    const calls = router.calls.filter((c) => c.path === "/reviews/rev-1/publish-plan");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("finding_ids")).toBe(`${ID_A},${ID_B}`);
  });

  it("maps a failed plan read to the unavailable fallback without a toast or retry", async () => {
    const { router } = renderWithProviders(<PlanProbe ids={[ID_A]} />, {
      routes: {
        "GET /reviews/:id/publish-plan": () => apiError(502, "gitlab_comment_failed", "GitLab is down"),
      },
    });

    expect(await screen.findByText("plan unavailable null null")).toBeInTheDocument();
    expect(screen.queryByText("GitLab is down")).not.toBeInTheDocument();
    expect(router.calls.filter((c) => c.path === "/reviews/rev-1/publish-plan")).toHaveLength(1);
  });

  it("surfaces an auth failure of the plan read as an error", async () => {
    renderWithProviders(<PlanProbe ids={[ID_A]} />, {
      routes: {
        "GET /reviews/:id/publish-plan": () => apiError(401, "unauthorized", "Sign in"),
      },
    });

    expect(await screen.findByText("plan error")).toBeInTheDocument();
  });

  it("refreshes the preview and the plan on a deprecated-run 409, without retrying the publish", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<PublishProbe />, {
      routes: {
        "GET /reviews/:id/publish-preview": PREVIEW,
        "GET /reviews/:id/publish-plan": () => ({
          other_drafts: 0,
          plan_available: true,
          placement: { positioned: 1, general: 0 },
        }),
        "POST /reviews/:id/publications": () =>
          apiError(409, "review_diff_outdated", "This review is outdated — confirm publishing its findings as deprecated."),
      },
    });
    const reads = (path: string) => router.calls.filter((c) => c.method === "GET" && c.path === path).length;
    const posts = () => router.calls.filter((c) => c.method === "POST");

    await waitFor(() => {
      expect(reads("/reviews/rev-1/publish-preview")).toBe(1);
      expect(reads("/reviews/rev-1/publish-plan")).toBe(1);
    });

    await user.click(screen.getByRole("button", { name: "publish" }));

    expect(await screen.findByText("publish failed review_diff_outdated")).toBeInTheDocument();
    await waitFor(() => {
      expect(reads("/reviews/rev-1/publish-preview")).toBe(2);
      expect(reads("/reviews/rev-1/publish-plan")).toBe(2);
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({ finding_ids: [ID_A], acknowledge_deprecated: false });
  });

  it("does not fetch the preview when disabled (GitHub PR)", async () => {
    const { router } = renderWithProviders(<PreviewProbe enabled={false} />, {
      routes: { "GET /reviews/:id/publish-preview": PREVIEW },
    });

    expect(await screen.findByText("preview idle")).toBeInTheDocument();
    expect(router.calls.some((c) => c.path.includes("publish-preview"))).toBe(false);
  });

  it("has a fallback message for every publish error code", () => {
    const codes = (testMessages.prHost as { publish: { code: Record<string, string> } }).publish.code;
    for (const code of PublishErrorCode.options) {
      expect(codes[code], code).toEqual(expect.any(String));
    }
  });
});
