/* OverviewTab — route-level navigation flow test (T18).

   This is deliberately NOT a component test of OverviewTab in isolation: the
   behaviour under test (AC-25, AC-28, AC-29) is a CHAIN that only exists once
   the tab is mounted by its route —

     ReviewFocusBlock / IntentCard risk-ref
       → OverviewTab's onGoToFinding / onGoToFile props
       → page.tsx's goToFinding / goToFile closures
       → the batched useSetQueryParams → ONE router.replace   (in-diff)
       → githubBlobUrl(...) + window.open(..., "_blank", "noopener,noreferrer") (out-of-diff)

   Rendering OverviewTab with vi.fn() handlers would stop at the first arrow and
   could not assert the single history entry or the blob fallback at all (those
   assertions already exist one level down in ReviewFocusBlock.test.tsx). So the
   real page component is rendered and only its CHROME is stubbed — AppShell and
   PrDetailHeader are outside the chain. Everything the chain touches
   (OverviewTab, its three children, the page closures, useSetQueryParams and
   githubBlobUrl) is the real implementation.

   NOTE: @testing-library/user-event is not a client devDependency; the whole
   suite interacts via fireEvent (see IntentCard/PrBriefCard/ReviewFocusBlock
   tests) — we follow that pattern rather than adding a package from a test file. */

import { describe, it, expect, afterEach, beforeEach, beforeAll, vi, type Mock } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BlastResponse,
  IntentDetail,
  PrBriefDetail,
  PrDetail,
  PrMeta,
} from "@devdigest/shared";
import briefMessages from "../../../../../../../../messages/en/brief.json";
import blastMessages from "../../../../../../../../messages/en/blast.json";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";

const REPO_ID = "repo-1";
const PR_NUMBER = 7;
const PR_ID = "11111111-1111-4111-8111-111111111111";
const HEAD_SHA = "9f1c0de1234567890abcdef1234567890abcdef0";
const REPO_FULL_NAME = "acme/widgets";
const ROUTE = `/repos/${REPO_ID}/pulls/${PR_NUMBER}`;

// The router is the only thing standing between the page and the URL — every
// navigation in this flow must surface here as exactly one replace() call.
const { router } = vi.hoisted(() => ({
  router: {
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ repoId: REPO_ID, number: String(PR_NUMBER) }),
  useRouter: () => router,
  // Read from the live jsdom URL so the page's `?tab` default (overview) and
  // the setter's rebuild-from-live-location contract agree.
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));

// Every fetch in the tree goes through lib/api — swap the client, keep the
// rest of the module (page.tsx imports ApiError from here).
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

// Repo identity feeds repoFullName (the blob-URL owner/repo) — provide it
// directly instead of booting RepoProvider + the /repos query.
vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: REPO_ID,
    setRepoId: () => {},
    repos: [{ id: REPO_ID, full_name: REPO_FULL_NAME }],
    activeRepo: { id: REPO_ID, full_name: REPO_FULL_NAME },
    reposLoaded: true,
  }),
  useRepoNotFound: () => false,
}));

// --- Chrome, outside the navigation chain: stubbed to keep the test honest ---
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../PrDetailHeader", () => ({
  PrDetailHeader: () => <header data-testid="pr-detail-header" />,
}));

import { api } from "@/lib/api";
import { githubBlobUrl } from "@/lib/github-urls";
import PRDetailPage from "../../page";

/** Two of the three review-focus paths are in the diff; `src/legacy/helper.ts` is not. */
const PR_FILES = [
  { path: "src/api/users.ts", additions: 24, deletions: 3, patch: null },
  { path: "src/config.ts", additions: 4, deletions: 0, patch: null },
];

const PR_META: PrMeta = {
  id: PR_ID,
  number: PR_NUMBER,
  title: "Add per-IP rate limiting",
  author: "dev",
  branch: "feat/ratelimit",
  base: "main",
  head_sha: HEAD_SHA,
  additions: 28,
  deletions: 3,
  files_count: 2,
  status: "open",
};

const PR: PrDetail = {
  ...PR_META,
  body: "Rate-limits the public API.",
  files: PR_FILES,
  commits: [],
};

const INTENT: IntentDetail = {
  pr_id: PR_ID,
  intent: "Introduce per-IP rate limiting on the public API endpoints.",
  in_scope: ["Token-bucket middleware"],
  out_of_scope: ["Auth changes"],
  risk_areas: ["Auth surface touched"],
  confidence: "high",
  sources: [{ kind: "pr_description", ref: "PR description", status: "fetched" }],
  model: "google/gemini-2.5-flash-lite",
  head_sha: HEAD_SHA,
  generated_at: "2026-08-27T00:00:00.000Z",
  stale: false,
};

const BLAST: BlastResponse = {
  status: "empty",
  reason: null,
  counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
  symbols: [],
  endpoints: [],
  prior_prs: [],
  summary: null,
};

const BRIEF: PrBriefDetail = {
  pr_id: PR_ID,
  what: "Adds per-IP rate limiting middleware to every public API endpoint.",
  why: "Unauthenticated clients were able to exhaust the payments API.",
  risks: [
    {
      kind: "performance",
      title: "N+1 under the new limiter",
      explanation: "The users listing issues one posts lookup per row.",
      severity: "medium",
      // In the diff → this ref must navigate in-app, not to github.com (AC-25).
      refs: [{ path: "src/api/users.ts", start_line: 46 }],
    },
  ],
  // Order is the generation's; the mix is deliberate — one entry WITH a finding,
  // one out-of-diff without, one in-diff without.
  review_focus: [
    {
      path: "src/config.ts",
      line: 12,
      reason: "live Stripe key committed in plaintext",
      finding_id: "finding-42",
    },
    {
      path: "src/legacy/helper.ts",
      line: 88,
      reason: "caller of the changed helper, outside this diff",
      finding_id: null,
    },
    {
      path: "src/api/users.ts",
      line: 46,
      reason: "N+1 query, hit harder under the new limiter",
      finding_id: null,
    },
  ],
  score: 61,
  risk_level: "medium",
  status: "request_changes",
  findings_count: 6,
  blockers: 2,
  cost_usd: 0.014,
  tokens_in: 8231,
  tokens_out: 1340,
  missing_inputs: [],
  model: "google/gemini-2.5-flash-lite",
  head_sha: HEAD_SHA,
  generated_at: "2026-08-27T00:00:00.000Z",
  stale: false,
  stale_reason: null,
  generation: { state: "ok", reason: null },
};

/** Route every GET the Overview tree fires; unknown paths fail loudly. */
function routeGet(path: string): Promise<unknown> {
  switch (path) {
    case `/repos/${REPO_ID}/pulls`:
      return Promise.resolve([PR_META]);
    case `/pulls/${PR_ID}`:
      return Promise.resolve(PR);
    case `/pulls/${PR_ID}/brief`:
      return Promise.resolve(BRIEF);
    case `/pulls/${PR_ID}/intent`:
      return Promise.resolve(INTENT);
    case `/pulls/${PR_ID}/blast`:
      return Promise.resolve(BLAST);
    case `/pulls/${PR_ID}/reviews`:
    case `/pulls/${PR_ID}/runs`:
    case `/pulls/${PR_ID}/runs/active`:
      return Promise.resolve([]);
    default:
      return Promise.reject(new Error(`unexpected GET ${path}`));
  }
}

async function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={{ brief: briefMessages, blast: blastMessages, prReview: prReviewMessages }}
      >
        <PRDetailPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  // The tab only mounts once the pulls list → uuid → detail chain resolves.
  await screen.findByText("Review focus — read these first");
}

/** Review-focus entries are role=button with an explicit aria-label (NFR-5). */
function focusEntry(ref: string, reason: string): HTMLElement {
  return screen.getByRole("button", { name: `${ref} — Reason: ${reason}` });
}

beforeAll(() => {
  // jsdom has no layout engine; the diff/finding targets call it on mount.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", ROUTE);
  (api.get as Mock).mockImplementation((path: string) => routeGet(path));
});

afterEach(cleanup);

describe("Overview tab — navigation flow", () => {
  it("renders the PR Brief card, then the Intent + Blast grid, then Review Focus", async () => {
    await renderRoute();

    const card = screen.getByText("PR Brief");
    const intent = screen.getByText("Intent");
    const focus = screen.getByText("Review focus — read these first");

    // AC-26 / G1,G3: sibling sections in a fragment — assert real DOM order.
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(card, intent)).toBe(true);
    expect(follows(intent, focus)).toBe(true);
    // Blast sits beside Intent, still above Review Focus.
    expect(follows(screen.getByText("Blast Radius"), focus)).toBe(true);
  });

  it("AC-28: a review-focus entry with a finding lands on ?tab=findings&finding=<id> in ONE history entry", async () => {
    await renderRoute();

    fireEvent.click(focusEntry("src/config.ts:12", "live Stripe key committed in plaintext"));

    // The whole point of the batched setter: `tab` and `finding` are two
    // different keys written in the same tick, so they must be ONE replace().
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(`${ROUTE}?tab=findings&finding=finding-42`, {
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("AC-29: a review-focus entry without a finding, whose file IS in the diff, lands on ?tab=diff&file&line in ONE history entry", async () => {
    await renderRoute();

    fireEvent.click(
      focusEntry("src/api/users.ts:46", "N+1 query, hit harder under the new limiter"),
    );

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      `${ROUTE}?tab=diff&file=src%2Fapi%2Fusers.ts&line=46`,
      { scroll: false },
    );
  });

  it("AC-29/AC-25: a review-focus entry for a file OUTSIDE the diff opens the GitHub blob at the PR head SHA in a new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await renderRoute();

    fireEvent.click(
      focusEntry("src/legacy/helper.ts:88", "caller of the changed helper, outside this diff"),
    );

    const expected = githubBlobUrl(REPO_FULL_NAME, HEAD_SHA, "src/legacy/helper.ts", 88);
    expect(expected).toBe(
      `https://github.com/${REPO_FULL_NAME}/blob/${HEAD_SHA}/src/legacy/helper.ts#L88`,
    );
    expect(open).toHaveBeenCalledTimes(1);
    // Security: the opened tab must not get window.opener nor a Referer.
    expect(open).toHaveBeenCalledWith(expected, "_blank", "noopener,noreferrer");
    // Out-of-diff means no in-app navigation happened at all.
    expect(router.replace).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("AC-25: a risk's file reference in the Intent card uses the same single-write navigation", async () => {
    await renderRoute();

    // Collapsed rows already expose their primary ref as a button.
    fireEvent.click(await screen.findByRole("button", { name: "src/api/users.ts:46" }));

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      `${ROUTE}?tab=diff&file=src%2Fapi%2Fusers.ts&line=46`,
      { scroll: false },
    );
  });
});
