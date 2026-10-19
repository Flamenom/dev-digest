import { describe, it, expect } from "vitest";
import type { HostLinkRepo } from "@/lib/host-urls";
import { fileHrefFor } from "./helpers";

const F = { file: "src/config.ts", start_line: 10, end_line: 20 };
const SHA = "0123abcd";
const GITLAB: HostLinkRepo = {
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/space-profit/platform/crm-frontend",
  full_name: "space-profit/platform/crm-frontend",
};
const GITHUB: HostLinkRepo = {
  provider: "github",
  host: "github.com",
  web_url: "https://github.com/acme/payments-api",
  full_name: "acme/payments-api",
};

describe("fileHrefFor", () => {
  it("builds the host blob link when a host is provided", () => {
    expect(fileHrefFor(F, SHA, { repo: GITLAB, readOnly: true }, null)).toBe(
      `https://gitlab.com/space-profit/platform/crm-frontend/-/blob/${SHA}/src/config.ts#L10-20`,
    );
    expect(fileHrefFor(F, SHA, { repo: GITHUB, readOnly: false }, null)).toBe(
      `https://github.com/acme/payments-api/blob/${SHA}/src/config.ts#L10-L20`,
    );
  });

  it("falls back to the legacy GitHub link without a host provider", () => {
    expect(fileHrefFor(F, SHA, null, "acme/payments-api")).toBe(
      `https://github.com/acme/payments-api/blob/${SHA}/src/config.ts#L10-L20`,
    );
  });

  it("renders no link without a head SHA, an unloaded host repo, an unsafe web_url or a repo name", () => {
    expect(fileHrefFor(F, null, { repo: GITLAB, readOnly: true }, "acme/payments-api")).toBeUndefined();
    expect(fileHrefFor(F, SHA, { repo: null, readOnly: true }, "acme/payments-api")).toBeUndefined();
    expect(
      fileHrefFor(F, SHA, { repo: { ...GITLAB, web_url: "javascript:alert(1)" }, readOnly: true }, null),
    ).toBeUndefined();
    expect(fileHrefFor(F, SHA, null, null)).toBeUndefined();
  });
});
