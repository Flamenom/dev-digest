import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { SkillImportPreview } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/skills.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}));

const PREVIEW: SkillImportPreview = {
  name: "flaky-test-patterns",
  description: "Spot flaky-test smells",
  body: "# Flaky test patterns\nAvoid sleeps.",
  suggested_type: "custom",
  skipped: ["install.sh", "bin/tool"],
  warnings: ["Description truncated"],
};

const previewMutate = vi.fn(
  (_file: File, opts?: { onSuccess?: (p: SkillImportPreview) => void }) => opts?.onSuccess?.(PREVIEW),
);
const createMutate = vi.fn(
  (
    vars: Record<string, unknown>,
    opts?: { onSuccess?: (s: { id: string; name: string }) => void },
  ) => opts?.onSuccess?.({ id: "sk-new", name: String(vars.name) }),
);

vi.mock("@/lib/hooks/skills", () => ({
  useImportSkillPreview: () => ({ mutate: previewMutate, isPending: false, isError: false }),
  useCreateSkill: () => ({ mutate: createMutate, isPending: false }),
}));

import { ImportSkillModal } from "./ImportSkillModal";

afterEach(() => {
  cleanup();
  previewMutate.mockClear();
  createMutate.mockClear();
  push.mockClear();
});

function renderModal(onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <ImportSkillModal onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return onClose;
}

function pickFileAndPreview() {
  const file = new File(["# Flaky"], "flaky-test-patterns.zip", { type: "application/zip" });
  fireEvent.change(screen.getByLabelText("Skill file"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
  return file;
}

describe("ImportSkillModal", () => {
  it("previews the file and lists skipped entries + warnings explicitly", () => {
    renderModal();
    const file = pickFileAndPreview();
    expect(previewMutate).toHaveBeenCalledWith(file, expect.anything());
    expect(screen.getByDisplayValue("flaky-test-patterns")).toBeInTheDocument();
    expect(screen.getByText("Skipped entries — not processed")).toBeInTheDocument();
    expect(screen.getByText("install.sh")).toBeInTheDocument();
    expect(screen.getByText("bin/tool")).toBeInTheDocument();
    expect(screen.getByText("Warnings")).toBeInTheDocument();
    expect(screen.getByText("Description truncated")).toBeInTheDocument();
  });

  it("confirm posts source 'community' + enabled false, toasts and navigates", () => {
    const onClose = renderModal();
    pickFileAndPreview();
    fireEvent.click(screen.getByRole("button", { name: /Import skill/ }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [vars] = createMutate.mock.calls[0]!;
    expect(vars).toEqual({
      name: "flaky-test-patterns",
      description: "Spot flaky-test smells",
      type: "custom",
      body: "# Flaky test patterns\nAvoid sleeps.",
      source: "community",
      enabled: false,
    });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Disabled until you vet"));
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/skills/sk-new");
  });

  it("cancel just closes without persisting", () => {
    const onClose = renderModal();
    pickFileAndPreview();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalled();
    expect(createMutate).not.toHaveBeenCalled();
  });
});
