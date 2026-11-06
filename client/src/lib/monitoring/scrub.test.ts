import { describe, it, expect } from "vitest";
import { scrubEvent, scrubString, MASK } from "./scrub";

/* Canary matrix (AC-36, AC-38): every secret shape × every event location →
   the serialized scrubbed event contains none of the canaries. */

const CANARIES = {
  pat: "ddg_pat_CANARYpat0123456789abcdef",
  session: "CANARYsessionValue0123456789",
  github: "ghp_CANARYgithub0123456789abcdefABCD",
  githubFine: "github_pat_CANARYfine0123456789abcdef",
  gitlab: "glpat-CANARYgitlab0123456789",
  openai: "sk-CANARYopenai0123456789abcdef",
  openrouter: "sk-or-v1-CANARYrouter0123456789abcdef",
  googleKey: "AIzaCANARYgoogle0123456789abcdefghijklm",
  googleSecret: "GOCSPX-CANARYclientSecret0123",
  jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYsig0123",
  code: "CANARYoauthCode0123",
  state: "CANARYoauthState0123",
  dbPass: "CANARYdbPassword0123",
  masterKey: "CANARYmasterKey0123456789",
  bearer: "CANARYbearer0123456789",
} as const;

/** One string carrying every canary in the shape it would appear in the wild. */
const LOADED = [
  `Bearer ${CANARIES.bearer}`,
  `token ${CANARIES.pat}`,
  `__Host-ddg_session=${CANARIES.session}; theme=dark`,
  `https://x-access-token:${CANARIES.github}@github.com/acme/repo.git`,
  `fine ${CANARIES.githubFine}`,
  `gitlab ${CANARIES.gitlab}`,
  `llm ${CANARIES.openai} / ${CANARIES.openrouter}`,
  `google ${CANARIES.googleKey} ${CANARIES.googleSecret}`,
  `/auth/callback?code=${CANARIES.code}&state=${CANARIES.state}&id_token=${CANARIES.jwt}`,
  `postgres://devdigest:${CANARIES.dbPass}@db:5432/devdigest`,
  `master_key=${CANARIES.masterKey}`,
].join(" | ");

function expectClean(serialized: string) {
  for (const [name, canary] of Object.entries(CANARIES)) {
    expect(serialized, `canary ${name} leaked`).not.toContain(canary);
  }
}

describe("scrubString", () => {
  it("masks every credential shape and keeps the surrounding text", () => {
    const out = scrubString(LOADED);
    expectClean(out);
    expect(out).toContain(MASK);
    expect(out).toContain("github.com/acme/repo.git");
    expect(out).toContain("theme=dark");
    expect(scrubString("TypeError: x is undefined")).toBe("TypeError: x is undefined");
  });
});

describe("scrubEvent", () => {
  it("removes every canary from every event location and keeps user.id only", () => {
    const event = {
      event_id: "abc123",
      message: LOADED,
      exception: { values: [{ type: "Error", value: LOADED }] },
      request: {
        url: `https://devdigest.example/auth/callback?code=${CANARIES.code}&state=${CANARIES.state}`,
        query_string: `code=${CANARIES.code}`,
        cookies: { "__Host-ddg_session": CANARIES.session },
        data: { password: CANARIES.dbPass },
        headers: {
          Authorization: `Bearer ${CANARIES.pat}`,
          Cookie: `__Host-ddg_session=${CANARIES.session}`,
          "Set-Cookie": `__Host-ddg_session=${CANARIES.session}`,
          "user-agent": "Mozilla/5.0",
        },
      },
      breadcrumbs: [{ message: LOADED, data: { url: LOADED } }],
      extra: { note: LOADED, nested: { deeper: [LOADED] } },
      contexts: { app: { detail: LOADED } },
      tags: { route: LOADED },
      user: {
        id: "u-1",
        email: "ann@example.com",
        username: "ann",
        ip_address: "203.0.113.7",
      },
    };

    const out = scrubEvent(event);
    const serialized = JSON.stringify(out);

    expectClean(serialized);
    expect(out.user).toEqual({ id: "u-1" });
    expect(serialized).not.toContain("ann@example.com");
    expect(serialized).not.toContain("203.0.113.7");
    expect(out.breadcrumbs).toEqual([]);
    expect(out.request).toEqual({
      url: "https://devdigest.example/auth/callback",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    // The input is not mutated.
    expect(event.request.headers.Authorization).toContain(CANARIES.pat);
  });
});
