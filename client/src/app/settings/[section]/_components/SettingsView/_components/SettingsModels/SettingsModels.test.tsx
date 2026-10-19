import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import authMessages from "../../../../../../../../messages/en/auth.json";
import { FEATURE_MODELS } from "@/lib/feature-models";

/* AC-33 (Settings → Models row): Member → selectors inert ("disabled") with a
   visible "Admins only" explanation linked to each; Admin → live selectors. */

const mutate = vi.fn();
vi.mock("@/lib/hooks", () => ({
  useSettings: () => ({ data: { feature_models: {} } }),
  useUpdateSettings: () => ({ mutate, isPending: false }),
}));
vi.mock("@/lib/hooks/agents", () => ({
  useProviderModels: () => ({ data: [] }),
}));

import { SettingsModels } from "./SettingsModels";

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

function renderModels(readOnly: boolean) {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages, auth: authMessages }}>
      <SettingsModels readOnly={readOnly} />
    </NextIntlClientProvider>,
  );
}

describe("SettingsModels gating", () => {
  it("Member: every selector is a focusable, aria-disabled read-only value described by 'Admins only'", () => {
    renderModels(true);

    expect(screen.getByText(authMessages.gate.adminsOnly)).toBeVisible();
    const first = FEATURE_MODELS[0]!;
    const box = screen.getByRole("textbox", { name: `${first.label} model` });
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).toHaveAttribute("aria-readonly", "true");
    expect(box).toHaveAccessibleDescription(authMessages.gate.adminsOnly);
    expect(box).toHaveTextContent(first.defaultModel);
    box.focus();
    expect(box).toHaveFocus();
    expect(screen.getAllByRole("textbox")).toHaveLength(FEATURE_MODELS.length);
  });

  it("Admin: no hint and no read-only values", () => {
    renderModels(false);

    expect(screen.queryByText(authMessages.gate.adminsOnly)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: `${FEATURE_MODELS[0]!.label} model` })).not.toBeInTheDocument();
  });
});
