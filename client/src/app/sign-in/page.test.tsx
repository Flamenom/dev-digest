import { describe, it, expect, vi } from "vitest";
import { createTranslator } from "next-intl";
import authMessages from "../../../messages/en/auth.json";

/* The /sign-in route exports its own metadata (tab title, not indexed). */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: { auth: authMessages }, namespace: namespace as "auth" }),
}));

import { generateMetadata } from "./page";

describe("/sign-in metadata", () => {
  it("sets a localized title and opts out of indexing", async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toBe(authMessages.signIn.metaTitle);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
