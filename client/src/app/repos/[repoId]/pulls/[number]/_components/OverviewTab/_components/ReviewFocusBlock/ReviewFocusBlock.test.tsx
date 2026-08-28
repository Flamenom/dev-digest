import { describe, it, expect, afterEach, vi } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see IntentCard/SkillsTab tests) — we follow
// that pattern rather than adding a package from a test file.
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReviewFocusEntry } from "@devdigest/shared";
import messages from "../../../../../../../../../../messages/en/brief.json";

import { ReviewFocusBlock } from "./ReviewFocusBlock";

afterEach(cleanup);

/** Deliberately NOT sorted by path, line or severity — the model's order is the product. */
const ENTRIES: ReviewFocusEntry[] = [
  {
    path: "src/config.ts",
    line: 12,
    reason: "live Stripe key (sk_live_…) committed in plaintext",
    finding_id: "finding-1",
  },
  {
    path: "src/api/public/webhooks.ts",
    line: 61,
    reason: "request callback_url forwards the account token to a caller-controlled URL",
  },
  {
    path: "src/api/users.ts",
    line: 46,
    reason: "N+1 query — one posts lookup per user, hit harder under the new limiter",
    finding_id: null,
  },
];

function renderBlock(
  entries: ReviewFocusEntry[],
  handlers: {
    onGoToFinding?: (findingId: string) => void;
    onGoToFile?: (file: string, line?: number) => void;
  } = {},
) {
  const onGoToFinding = handlers.onGoToFinding ?? vi.fn();
  const onGoToFile = handlers.onGoToFile ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={{ brief: messages }}>
      <ReviewFocusBlock
        entries={entries}
        onGoToFinding={onGoToFinding}
        onGoToFile={onGoToFile}
      />
    </NextIntlClientProvider>,
  );
  return { onGoToFinding, onGoToFile };
}

describe("ReviewFocusBlock", () => {
  it("renders the heading, a badge equal to the entry count, and every entry in the persisted order with its file:line and reason", () => {
    renderBlock(ENTRIES);

    expect(screen.getByText("Review focus — read these first")).toBeInTheDocument();
    // The badge reads the rendered entry count, not any model-claimed number.
    expect(screen.getByText("3")).toBeInTheDocument();

    // AC-26: rendered order === payload order (no client re-sort).
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent)).toEqual([
      "src/config.ts:12— live Stripe key (sk_live_…) committed in plaintext",
      "src/api/public/webhooks.ts:61— request callback_url forwards the account token to a caller-controlled URL",
      "src/api/users.ts:46— N+1 query — one posts lookup per user, hit harder under the new limiter",
    ]);

    // AC-27: no entry renders without BOTH the file:line ref and the reason.
    for (const entry of ENTRIES) {
      expect(screen.getByText(`${entry.path}:${entry.line}`)).toBeInTheDocument();
      expect(screen.getByText(`— ${entry.reason}`)).toBeInTheDocument();
    }
  });

  it("every entry is a native, tab-reachable button that activates on Enter and on Space", () => {
    const { onGoToFinding, onGoToFile } = renderBlock(ENTRIES);
    const rows = screen.getAllByRole("button");

    for (const row of rows) {
      // Native <button> ⇒ the browser itself maps Enter/Space to a click and
      // keeps the control in the tab order — no hand-rolled key handling.
      expect(row.tagName).toBe("BUTTON");
      expect(row).toHaveAttribute("type", "button");
      expect(row).not.toHaveAttribute("tabindex");
      row.focus();
      expect(row).toHaveFocus();
    }

    // Enter on the focused entry (keydown + the click the UA dispatches).
    const first = rows[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "Enter", code: "Enter" });
    fireEvent.click(first);
    expect(onGoToFinding).toHaveBeenCalledTimes(1);

    // Space on the last entry — same activation path, different callback.
    const last = rows[2]!;
    last.focus();
    fireEvent.keyDown(last, { key: " ", code: "Space" });
    fireEvent.keyUp(last, { key: " ", code: "Space" });
    fireEvent.click(last);
    expect(onGoToFile).toHaveBeenCalledTimes(1);
    expect(onGoToFile).toHaveBeenCalledWith("src/api/users.ts", 46);
  });

  it("routes an entry with a finding_id to onGoToFinding and one without it to onGoToFile", () => {
    const { onGoToFinding, onGoToFile } = renderBlock(ENTRIES);
    const rows = screen.getAllByRole("button");

    fireEvent.click(rows[0]!); // finding_id: "finding-1"
    expect(onGoToFinding).toHaveBeenCalledTimes(1);
    expect(onGoToFinding).toHaveBeenCalledWith("finding-1");
    expect(onGoToFile).not.toHaveBeenCalled();

    fireEvent.click(rows[1]!); // finding_id absent
    expect(onGoToFile).toHaveBeenCalledTimes(1);
    expect(onGoToFile).toHaveBeenCalledWith("src/api/public/webhooks.ts", 61);
    expect(onGoToFinding).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate path:line entries — the block never dedups the generation's order", () => {
    const dupe: ReviewFocusEntry = { ...ENTRIES[0]!, reason: "second pass on the same line" };
    renderBlock([ENTRIES[0]!, dupe]);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getAllByText("src/config.ts:12")).toHaveLength(2);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("with zero entries renders the heading and the empty state instead of omitting the section", () => {
    renderBlock([]);

    expect(screen.getByText("Review focus — read these first")).toBeInTheDocument();
    expect(screen.getByText("No reading order was derived for this PR.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // No badge — a "0" chip next to the empty state would be noise.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
