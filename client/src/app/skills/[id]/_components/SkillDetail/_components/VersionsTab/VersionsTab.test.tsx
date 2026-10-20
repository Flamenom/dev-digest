import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Skill, SkillVersionEntryWithAuthor } from "@devdigest/shared";
import { renderWithProviders } from "@/test/render-with-providers";
import { VersionsTab } from "./VersionsTab";

const VERSIONS: SkillVersionEntryWithAuthor[] = [
  { skill_id: "sk1", version: 2, note: "Tightened rubric", body: "new body", created_at: "2026-08-18T10:00:00Z" },
  { skill_id: "sk1", version: 1, note: null, body: "old body", created_at: "2026-08-17T10:00:00Z" },
];

const SKILL: Skill = {
  id: "sk1",
  name: "branch-coverage-rubric",
  description: "d",
  type: "rubric",
  source: "manual",
  body: "new body",
  enabled: true,
  version: 2,
  attached_doc_paths: [],
};

function renderTab({
  session = "admin",
  versions = VERSIONS,
}: { session?: "admin" | "member"; versions?: SkillVersionEntryWithAuthor[] } = {}) {
  return renderWithProviders(<VersionsTab skill={SKILL} />, {
    session,
    routes: {
      "GET /skills/sk1/versions": versions,
      "POST /skills/sk1/restore": { ...SKILL, body: "old body", version: 3 },
    },
  });
}

/** The restore button of the restorable row (v1; the head row's is natively disabled). */
async function findRestoreV1() {
  const buttons = await screen.findAllByRole("button", { name: /Restore/ });
  const v1 = buttons.at(1);
  if (!v1) throw new Error("no v1 restore button");
  return v1;
}

afterEach(() => vi.restoreAllMocks());

describe("VersionsTab", () => {
  it("lists versions newest-first with note fallback and Current chip", async () => {
    renderTab();
    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("Tightened rubric")).toBeInTheDocument();
    expect(screen.getByText("Body updated")).toBeInTheDocument(); // null-note fallback
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("restore confirms, POSTs the version and confirms with a toast", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { router } = renderTab();
    const restore = await findRestoreV1();
    await waitFor(() => expect(restore).not.toHaveAttribute("aria-disabled"));
    await user.click(restore);

    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByText("Restored from v1")).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({ version: 1 });
  });

  it("diff opens a modal with added/removed lines vs the previous version", async () => {
    const user = userEvent.setup();
    renderTab();
    const [diffV2] = await screen.findAllByRole("button", { name: /Diff/ });
    if (!diffV2) throw new Error("no diff button");
    await user.click(diffV2); // v2 vs v1
    expect(screen.getByText("Diff v1 → v2")).toBeInTheDocument();
    expect(screen.getByText("old body")).toBeInTheDocument();
    expect(screen.getByText("new body")).toBeInTheDocument();
  });
});

describe("VersionsTab gating + version author (AC-33, AC-47/48)", () => {
  it("Member: Restore is aria-disabled with an 'Admins only' hint and never confirms or POSTs; Diff stays usable", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { router } = renderTab({ session: "member" });
    const restore = await findRestoreV1();
    await waitFor(() => expect(restore).toHaveAccessibleDescription("Admins only"));
    expect(restore).toHaveAttribute("aria-disabled", "true");
    await user.click(restore);

    // Sync point: Diff is allowed for a Member — open it and wait for it. Any
    // confirm/POST the gated click had started has happened (and its toast
    // rendered) by then.
    const [diffV2] = screen.getAllByRole("button", { name: /Diff/ });
    if (!diffV2) throw new Error("no diff button");
    await user.click(diffV2);
    expect(await screen.findByText("Diff v1 → v2")).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Restored from v1")).not.toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names each version's author when present: user name, Local user, or —", async () => {
    const [v2, v1] = VERSIONS;
    if (!v2 || !v1) throw new Error("fixture");
    renderTab({
      versions: [
        { ...v2, author: { user_id: "u2", name: "Ann" } },
        { ...v1, author: { user_id: "sys", name: "System", is_system: true } },
      ],
    });
    expect(await screen.findByText(/Ann/)).toBeInTheDocument();
    expect(screen.getByText(/Local user/)).toBeInTheDocument();
    // Session-resolved signal (Admin): Restore turns live — only then is the
    // missing "Admins only" hint meaningful.
    const restore = await findRestoreV1();
    await waitFor(() => expect(restore).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });
});
