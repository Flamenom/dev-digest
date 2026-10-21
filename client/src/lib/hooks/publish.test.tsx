/* Publish-findings data layer (spec 2026-10-21-gitlab-publish-findings,
   AC-3/AC-38/AC-39): polling while in progress, the terminal refresh of the
   preview, the other-drafts fallback and the GitHub "no request" rule —
   asserted through rendered output and the requests that reach the router. */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, waitFor, act } from "@testing-library/react";
import { PublishErrorCode } from "@devdigest/shared";
import type { Publication, PublishPreview } from "../types";
import { renderWithProviders, apiError, testMessages } from "@/test/render-with-providers";
import {
  PUBLICATION_POLL_MS,
  useOtherDraftsCount,
  usePublication,
  usePublishPreview,
} from "./publish";

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
