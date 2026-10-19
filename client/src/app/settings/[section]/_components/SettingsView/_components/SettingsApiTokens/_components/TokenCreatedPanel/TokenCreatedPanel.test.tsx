import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
// user-event is not installed in this package — fireEvent is the local idiom.
import { NextIntlClientProvider } from "next-intl";
import settingsMessages from "../../../../../../../../../../messages/en/settings.json";
import { TokenCreatedPanel } from "./TokenCreatedPanel";

const TOKEN = "ddg_pat_abcdefghijklmnopqrstuvwxyz0123456789";

function renderPanel() {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages }}>
      <TokenCreatedPanel token={TOKEN} onDone={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

// Own-property descriptor before any stub (jsdom usually has none — clipboard lives on the
// prototype or is absent), so afterEach can put navigator back exactly as it was.
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

function restoreClipboard() {
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    // Removing the own property re-exposes whatever the prototype provides (or nothing).
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
}

afterEach(() => {
  cleanup();
  restoreClipboard();
  vi.restoreAllMocks();
});

describe("TokenCreatedPanel", () => {
  it("shows Copied only after the clipboard write succeeds", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    renderPanel();
    stubClipboard(writeText);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(screen.queryByText(/Copy failed/)).not.toBeInTheDocument();
  });

  it("on a rejected write keeps Copy, selects the value and shows the manual-copy hint", async () => {
    renderPanel();
    stubClipboard(() => Promise.reject(new Error("denied")));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByText("Copy failed — select and copy manually")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: settingsMessages.apiTokens.tokenValueLabel }) as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(TOKEN.length);
  });
});
