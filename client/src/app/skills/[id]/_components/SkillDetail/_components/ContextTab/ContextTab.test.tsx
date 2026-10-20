import { describe, it, expect } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import type { DiscoveredDocument, DiscoverySummary, Skill } from "@devdigest/shared";
import { useSkill } from "@/lib/hooks/skills";
import { renderWithProviders, testRepo, type RouteRequest } from "@/test/render-with-providers";
import { ContextTab } from "./ContextTab";

const REPO = testRepo({ name: "api", full_name: "acme/api", clone_path: "/clones/acme/api" });

const DOCS: DiscoveredDocument[] = [
  { path: "specs/auth.md", bucket: "specs", estimated_tokens: 120 },
  { path: "docs/guide/setup.md", bucket: "docs", estimated_tokens: 80 },
  { path: "insights/perf.md", bucket: "insights", estimated_tokens: 40 },
  // Root dir ("server") differs from the bucket ("docs") — badge shows the root dir.
  { path: "server/notes/arch.md", bucket: "docs", estimated_tokens: 60 },
];

const SUMMARY: DiscoverySummary = {
  document_count: 4,
  total_estimated_tokens: 300,
  refreshed_at: "2026-08-27T00:00:00.000Z",
  clone_available: true,
};

// Attached (ordered): setup first, then auth.
const SKILL: Skill = {
  id: "sk1",
  name: "arch-invariants",
  description: "Architecture invariants",
  type: "convention",
  source: "manual",
  body: "- rule",
  enabled: true,
  version: 1,
  attached_doc_paths: ["docs/guide/setup.md", "specs/auth.md"],
};

/** Renders the tab from the real skill query, as SkillDetail does — so a saved
    attach/reorder shows up once the skill re-reads. */
function SkillContextFromApi() {
  const { data } = useSkill("sk1");
  return data ? <ContextTab skill={data} /> : null;
}

function renderTab(session: "admin" | "member" = "admin") {
  let skill = SKILL;
  return renderWithProviders(<SkillContextFromApi />, {
    session,
    routes: {
      "GET /repos": [REPO],
      "GET /repos/r1/project-context": { documents: DOCS, summary: SUMMARY },
      "GET /skills/sk1": () => skill,
      "PUT /skills/sk1/attached-docs": (req: RouteRequest) => {
        skill = { ...skill, attached_doc_paths: (req.body as { paths: string[] }).paths };
        return skill;
      },
    },
  });
}

/** The file names of the rows, in display order. */
const rowNames = () =>
  screen.getAllByRole("listitem").map((row) => {
    const name = DOCS.map((d) => d.path.split("/").pop() ?? d.path).find((n) => within(row).queryByText(n));
    return name ?? "?";
  });

function rowFor(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** Wait until the session resolved to Admin (checkboxes live). */
async function findLiveCheckbox(name: string) {
  await screen.findAllByRole("listitem");
  const box = within(rowFor(name)).getByRole("checkbox");
  await waitFor(() => expect(box).not.toHaveAttribute("aria-disabled"));
  return box;
}

describe("ContextTab", () => {
  it("renders attached-first rows, the attached count, the inheritance note, and the serializes-as path list", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    // Attached first (in attached order), then the rest in discovery order.
    expect(rowNames()).toEqual(["setup.md", "auth.md", "perf.md", "arch.md"]);

    expect(screen.getByText("2 attached")).toBeInTheDocument();
    expect(
      screen.getByText(/Any agent using this skill inherits these documents\./),
    ).toBeInTheDocument();

    // Row anatomy: root-dir badge (text label) + per-row token count + full path
    // + preview affordance.
    const authRow = rowFor("auth.md");
    expect(within(authRow).getByText("specs")).toBeInTheDocument();
    expect(within(authRow).getByText("specs/auth.md")).toBeInTheDocument();
    expect(within(authRow).getByText("~120 tokens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview auth.md" })).toBeInTheDocument();
    // server/notes/arch.md → badge "server" (root dir), NOT its bucket "docs".
    const archRow = rowFor("arch.md");
    expect(within(archRow).getByText("server")).toBeInTheDocument();
    expect(within(archRow).queryByText("docs")).not.toBeInTheDocument();
    expect(within(archRow).getByText("~60 tokens")).toBeInTheDocument();

    // "Serializes as" — the contribution heading + the attached paths (AC-17).
    const pre = screen.getByText(/## Project context/);
    expect(pre.textContent).toContain("- docs/guide/setup.md");
    expect(pre.textContent).toContain("- specs/auth.md");
  });

  it("attaching a document appends it to the ordered attached set", async () => {
    const { router } = renderTab();
    fireEvent.click(await findLiveCheckbox("perf.md"));
    expect(await screen.findByText("3 attached")).toBeInTheDocument();
    expect(rowNames().slice(0, 3)).toEqual(["setup.md", "auth.md", "perf.md"]);
    expect(router.calls.find((c) => c.method === "PUT")?.body).toEqual({
      paths: ["docs/guide/setup.md", "specs/auth.md", "insights/perf.md"],
    });
  });

  it("detaching a document drops it from the attached set", async () => {
    renderTab();
    fireEvent.click(await findLiveCheckbox("setup.md"));
    expect(await screen.findByText("1 attached")).toBeInTheDocument();
    expect(within(rowFor("setup.md")).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  });

  it("keyboard reorder (move up) moves the document first", async () => {
    renderTab();
    await findLiveCheckbox("auth.md");
    fireEvent.click(screen.getByRole("button", { name: "Move auth.md up" }));
    await waitFor(() => expect(rowNames().slice(0, 2)).toEqual(["auth.md", "setup.md"]));
  });

  it("search narrows the list by filename/path without changing attach state", async () => {
    const { router } = renderTab();
    await screen.findAllByRole("listitem");
    const search = screen.getByPlaceholderText("Search documents…");

    fireEvent.change(search, { target: { value: "perf" } });
    expect(rowNames()).toEqual(["perf.md"]);

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    // Toggles set before filtering remain set; nothing was persisted.
    expect(within(rowFor("setup.md")).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("ContextTab gating (AC-33)", () => {
  it("Member: read-only — notice shown, checkboxes and move buttons aria-disabled and inert; Preview still works", async () => {
    const { router } = renderTab("member");
    await screen.findAllByRole("listitem");
    const notice = "Only admins can change attached documents.";
    expect(screen.getByText(notice)).toBeInTheDocument();

    const perf = within(rowFor("perf.md")).getByRole("checkbox");
    expect(perf).toHaveAttribute("aria-disabled", "true");
    expect(perf).toHaveAccessibleDescription(notice);
    fireEvent.click(perf);
    expect(perf).toHaveAttribute("aria-checked", "false");

    const moveUp = screen.getByRole("button", { name: "Move auth.md up" });
    expect(moveUp).toHaveAttribute("aria-disabled", "true");
    expect(moveUp).toHaveAccessibleDescription(notice);
    fireEvent.click(moveUp);
    expect(rowNames().slice(0, 2)).toEqual(["setup.md", "auth.md"]);

    expect(screen.getByRole("button", { name: "Preview auth.md" })).not.toHaveAttribute("aria-disabled");
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
