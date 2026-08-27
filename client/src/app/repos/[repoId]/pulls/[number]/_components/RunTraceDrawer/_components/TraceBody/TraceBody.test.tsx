import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunTrace } from "@devdigest/shared";
import messages from "../../../../../../../../../../messages/en/runs.json"; // apps/web/messages/en/runs.json

import { TraceBody } from "./TraceBody";

// A trace with Project Context POPULATED: specs read, specs skipped, and the
// specs prompt-assembly segment present (AC-25 / AC-26 / AC-27).
const SPECS_READ = ["specs/2026-08-27-project-context.md", "docs/adr/001-vendored-shared.md"] as const;
const SPECS_MISSING = ["specs/deleted-spec.md"] as const;

const TRACE: RunTrace = {
  config: { agent: "Security", version: "1", provider: "openai", model: "gpt-4.1", pr: 482, source: "local" },
  stats: { duration_ms: 8200, tokens_in: 12000, tokens_out: 1500, cost_usd: 0.06, findings: 0, grounding: "0/0 passed" },
  prompt_assembly: {
    system: "You are a reviewer.",
    skills: null,
    memory: null,
    specs: "## specs/2026-08-27-project-context.md\nProject context body…",
    user: "Review PR #482",
  },
  tool_calls: [],
  raw_output: "{}",
  memory_pulled: [],
  specs_read: [...SPECS_READ],
  specs_missing: [...SPECS_MISSING],
  log: [],
};

afterEach(cleanup);

function renderTraceBody(trace: RunTrace) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ runs: messages }}>
      <div data-theme="dark">
        <TraceBody trace={trace} findings={[]} />
      </div>
    </NextIntlClientProvider>,
  );
}

describe("TraceBody — populated Project Context trace", () => {
  it("lists read specs and skipped specs in separate rows, and labels the specs prompt block", () => {
    renderTraceBody(TRACE);

    // AC-25 — "Specs read" row lists every path that was read.
    const readRow = screen.getByText("Specs read").closest("div")!;
    for (const path of SPECS_READ) expect(within(readRow).getByText(path)).toBeInTheDocument();
    expect(within(readRow).queryByText("none")).not.toBeInTheDocument();

    // AC-26 — a SEPARATE "Specs missing / skipped" row lists the skipped paths.
    const missingRow = screen.getByText("Specs missing / skipped").closest("div")!;
    expect(missingRow).not.toBe(readRow);
    for (const path of SPECS_MISSING) expect(within(missingRow).getByText(path)).toBeInTheDocument();
    expect(within(missingRow).queryByText("none")).not.toBeInTheDocument();
    // Read paths do not leak into the missing row.
    expect(within(missingRow).queryByText(SPECS_READ[0])).not.toBeInTheDocument();

    // AC-27 — the prompt assembly shows the untrusted specs block when
    // prompt_assembly.specs is non-null (section is collapsed by default).
    fireEvent.click(screen.getByTestId("trace-section-prompt-assembly"));
    expect(screen.getByTestId("prompt-block-specs")).toBeInTheDocument();
    expect(screen.getByText("Project context — attached specs (untrusted)")).toBeInTheDocument();
  });

  it("omits the specs prompt block when prompt_assembly.specs is null", () => {
    renderTraceBody({
      ...TRACE,
      prompt_assembly: { ...TRACE.prompt_assembly, specs: null },
    });

    fireEvent.click(screen.getByTestId("trace-section-prompt-assembly"));
    expect(screen.queryByTestId("prompt-block-specs")).not.toBeInTheDocument();
    expect(screen.queryByText("Project context — attached specs (untrusted)")).not.toBeInTheDocument();
  });
});
