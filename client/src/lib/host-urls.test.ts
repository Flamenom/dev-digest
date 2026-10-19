import { describe, it, expect } from "vitest";
import { hostBlobUrl, hostLabelKey, hostPrUrl, isReadOnlyHost, type HostLinkRepo } from "./host-urls";
import { githubBlobUrl, githubBlobUrlAtRef, githubPrUrl } from "./github-urls";

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

const SHA = "a1b2c3d4";

describe("host-urls — GitLab (AC-37)", () => {
  it("builds MR, file, line and range links under web_url", () => {
    const base = "https://gitlab.com/space-profit/platform/crm-frontend";
    expect(hostPrUrl(GITLAB, 5)).toBe(`${base}/-/merge_requests/5`);
    expect(hostBlobUrl(GITLAB, SHA, "src/app.ts")).toBe(`${base}/-/blob/${SHA}/src/app.ts`);
    expect(hostBlobUrl(GITLAB, SHA, "src/app.ts", 10)).toBe(`${base}/-/blob/${SHA}/src/app.ts#L10`);
    expect(hostBlobUrl(GITLAB, SHA, "src/app.ts", 10, 20)).toBe(
      `${base}/-/blob/${SHA}/src/app.ts#L10-20`,
    );
    expect(hostBlobUrl(GITLAB, SHA, "src/app.ts", 7, 7)).toBe(`${base}/-/blob/${SHA}/src/app.ts#L7`);
    // trailing slash on web_url is tolerated; path segments are encoded, "/" kept
    expect(hostBlobUrl({ ...GITLAB, web_url: `${base}/` }, "main", "docs/a b#.md")).toBe(
      `${base}/-/blob/main/docs/a%20b%23.md`,
    );
    expect(hostLabelKey(GITLAB)).toBe("gitlab");
  });

  it("returns null for unsafe or foreign-host web_url", () => {
    const bad = [
      "javascript:alert(1)//gitlab.com/x/y",
      "http://gitlab.com/x/y",
      "https://evil.example/x/y",
      "https://gitlab.com.evil.example/x/y",
      "https://gitlab.com:8443/x/y",
      "https://user:pw@gitlab.com/x/y",
      "https://gitlab.com/x/y?a=1",
      "https://gitlab.com/x/y#frag",
      "https://gitlab.com/",
      "not a url",
      "",
    ];
    for (const web_url of bad) {
      const repo = { ...GITLAB, web_url };
      expect(hostPrUrl(repo, 5), web_url).toBeNull();
      expect(hostBlobUrl(repo, SHA, "a.ts", 1, 2), web_url).toBeNull();
    }
  });
});

describe("host-urls — GitHub (AC-38)", () => {
  it("produces exactly the github-urls links", () => {
    expect(hostPrUrl(GITHUB, 42)).toBe(githubPrUrl(GITHUB.full_name, 42));
    for (const args of [[], [10], [10, 20], [7, 7]] as Array<[number?, number?]>) {
      expect(hostBlobUrl(GITHUB, SHA, "src/a b.ts", ...args)).toBe(
        githubBlobUrl(GITHUB.full_name, SHA, "src/a b.ts", ...args),
      );
    }
    expect(hostLabelKey(GITHUB)).toBe("github");
  });

  it("returns null when the repo host is not the link's host", () => {
    const foreign = { ...GITHUB, host: "gitlab.com" as const };
    expect(hostPrUrl(foreign, 1)).toBeNull();
    expect(hostBlobUrl(foreign, SHA, "a.ts")).toBeNull();
  });
});

describe("github-urls — githubBlobUrlAtRef (AC-36)", () => {
  it("builds branch-pinned blob links with optional line anchors", () => {
    const base = "https://github.com/acme/payments-api/blob/main/src/api/users.ts";
    expect(githubBlobUrlAtRef("acme/payments-api", "main", "src/api/users.ts")).toBe(base);
    expect(githubBlobUrlAtRef("acme/payments-api", "main", "src/api/users.ts", 3)).toBe(`${base}#L3`);
    expect(githubBlobUrlAtRef("acme/payments-api", "main", "src/api/users.ts", 3, 5)).toBe(
      `${base}#L3-L5`,
    );
    expect(githubBlobUrlAtRef("acme/payments-api", "main", "src/api/users.ts", 4, 4)).toBe(`${base}#L4`);
  });
});

describe("host-urls — provider helpers", () => {
  it("hostLabelKey falls back to github for a missing repo", () => {
    expect(hostLabelKey(null)).toBe("github");
    expect(hostLabelKey(undefined)).toBe("github");
  });

  it("isReadOnlyHost is true only for GitLab", () => {
    expect(isReadOnlyHost(GITLAB)).toBe(true);
    expect(isReadOnlyHost(GITHUB)).toBe(false);
    expect(isReadOnlyHost(null)).toBe(false);
    expect(isReadOnlyHost(undefined)).toBe(false);
  });
});
