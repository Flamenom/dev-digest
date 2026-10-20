import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import authMessages from "../../../../../../../../messages/en/auth.json";
import { FEATURE_MODELS } from "@/lib/feature-models";
import { renderWithProviders } from "@/test/render-with-providers";
import { SettingsModels } from "./SettingsModels";

/* AC-33 (Settings → Models row): Member → selectors inert ("disabled") with a
   visible "Admins only" explanation linked to each; Admin → live selectors. */

const [FIRST] = FEATURE_MODELS;

function renderModels(readOnly: boolean) {
  renderWithProviders(<SettingsModels readOnly={readOnly} />, {
    session: readOnly ? "member" : "admin",
    routes: { "GET /settings": { feature_models: {} }, "GET /providers/openrouter/models": [] },
  });
}

describe("SettingsModels gating", () => {
  it("Member: every selector is a focusable, aria-disabled read-only value described by 'Admins only'", async () => {
    if (!FIRST) throw new Error("FEATURE_MODELS is empty");
    renderModels(true);

    expect(screen.getByText(authMessages.gate.adminsOnly)).toBeVisible();
    const box = await screen.findByRole("textbox", { name: `${FIRST.label} model` });
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box).toHaveAttribute("aria-readonly", "true");
    expect(box).toHaveAccessibleDescription(authMessages.gate.adminsOnly);
    expect(box).toHaveTextContent(FIRST.defaultModel);
    box.focus();
    expect(box).toHaveFocus();
    expect(screen.getAllByRole("textbox")).toHaveLength(FEATURE_MODELS.length);
  });

  it("Admin: no hint and no read-only values", () => {
    if (!FIRST) throw new Error("FEATURE_MODELS is empty");
    renderModels(false);

    expect(screen.queryByText(authMessages.gate.adminsOnly)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: `${FIRST.label} model` })).not.toBeInTheDocument();
  });
});
