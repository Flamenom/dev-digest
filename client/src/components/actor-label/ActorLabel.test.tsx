import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import authMessages from "../../../messages/en/auth.json";
import { ActorLabel } from "./ActorLabel";
import { ActorAvatar } from "./ActorAvatar";
import { isSafeAvatarUrl } from "./helpers";

/* AC-48 labels: no actor → "—", seeded system user → "Local user", a real user
   by name; names are text (never HTML). Avatars load only from Google. */

afterEach(cleanup);

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("ActorLabel", () => {
  it("labels missing, system and real actors, rendering names as plain text", () => {
    renderWithIntl(
      <>
        <ActorLabel actor={null} verb="run" />
        <ActorLabel actor={undefined} />
        <ActorLabel actor={{ user_id: "sys", name: "System", is_system: true }} verb="run" />
        <ActorLabel actor={{ user_id: "u2", name: "Bob", is_system: false }} verb="dismissed" />
        <ActorLabel actor={{ user_id: "u3", name: "<img src=x onerror=alert(1)>Eve" }} />
      </>,
    );

    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Run by Local user")).toBeInTheDocument();
    expect(screen.getByText("Dismissed by Bob")).toBeInTheDocument();
    // The name is text, so no image element (of any role) was created from it.
    expect(screen.getByText("<img src=x onerror=alert(1)>Eve")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
  });
});

describe("ActorAvatar", () => {
  it("loads only https googleusercontent avatars, otherwise falls back to initials", () => {
    expect(isSafeAvatarUrl("https://lh3.googleusercontent.com/a/abc=s96-c")).toBe(true);
    for (const bad of [
      "http://lh3.googleusercontent.com/a",
      "https://evil.test/googleusercontent.com",
      "https://googleusercontent.com.evil.test/a",
      "https://user:pw@lh3.googleusercontent.com/a",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      null,
    ]) {
      expect(isSafeAvatarUrl(bad)).toBe(false);
    }

    // The photo is decorative (`alt=""` → role "presentation"); the name is rendered as text beside it.
    const { rerender } = render(<ActorAvatar name="Ann Lee" url="https://lh3.googleusercontent.com/a/x" />);
    expect(screen.getByRole("presentation")).toHaveAttribute("src", "https://lh3.googleusercontent.com/a/x");
    rerender(<ActorAvatar name="Ann Lee" url="https://evil.test/x.png" />);
    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
    expect(screen.getByText("AL")).toBeInTheDocument();
  });
});
