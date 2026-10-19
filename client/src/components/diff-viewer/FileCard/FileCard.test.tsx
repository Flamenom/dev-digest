import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFileHost } from "@/lib/types";
import shell from "../../../../messages/en/shell.json";
import prHost from "../../../../messages/en/prHost.json";
import { FileCard } from "./FileCard";

afterEach(cleanup);

function renderFile(file: PrFileHost) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ shell, prHost }}>
      <FileCard file={file} />
    </NextIntlClientProvider>,
  );
}

describe("FileCard host file shapes", () => {
  it("a renamed file shows old → new", () => {
    renderFile({
      path: "src/new.ts",
      previous_path: "src/old.ts",
      change_type: "renamed",
      additions: 0,
      deletions: 0,
      patch: null,
    });
    expect(screen.getByText("src/old.ts → src/new.ts")).toBeInTheDocument();
  });

  it("a host-omitted patch shows the too-large note (open by default, no patch)", () => {
    renderFile({ path: "dist/app.js", additions: 5000, deletions: 10, patch: null, patch_omitted: "too_large" });
    expect(screen.getByText("dist/app.js")).toBeInTheDocument();
    expect(screen.getByText("Diff too large on GitLab")).toBeInTheDocument();
    expect(screen.queryByText(/No diff text available/)).not.toBeInTheDocument();
  });
});
