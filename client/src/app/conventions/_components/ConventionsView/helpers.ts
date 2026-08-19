import type { Convention } from "@devdigest/shared";

/** Kebab-case slug of the first ~6 words of a rule ("## section" anchors). */
export function slugifyRule(rule: string): string {
  const slug = rule
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "convention";
}

/** `acme/payments-api` → `payments-api-conventions`. */
export function defaultSkillName(repoFullName: string): string {
  return `${repoShortName(repoFullName)}-conventions`;
}

export function defaultSkillDescription(repoFullName: string, count: number): string {
  return `${count} house conventions extracted from ${repoShortName(repoFullName)}`;
}

export function repoShortName(repoFullName: string): string {
  const parts = repoFullName.split("/");
  return parts[parts.length - 1] || repoFullName;
}

/** `src/api/users.ts:23-31` (line suffix omitted when lines are unresolved). */
export function evidenceLabel(c: Convention): string {
  if (c.evidence_start_line == null) return c.evidence_path;
  const end =
    c.evidence_end_line != null && c.evidence_end_line !== c.evidence_start_line
      ? `-${c.evidence_end_line}`
      : "";
  return `${c.evidence_path}:${c.evidence_start_line}${end}`;
}

const FENCE_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  py: "py",
  go: "go",
  rs: "rust",
  toml: "toml",
  md: "md",
  yml: "yaml",
  yaml: "yaml",
};

function fenceLangFor(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return FENCE_LANG[ext] ?? "";
}

/**
 * The generated skill body — one `##` section per accepted convention, each
 * citing its evidence. Matches the create-skill modal mock; the user edits it
 * freely before saving.
 */
export function generateSkillBody(repoFullName: string, accepted: Convention[]): string {
  const name = defaultSkillName(repoFullName);
  const seen = new Map<string, number>();

  const sections = accepted.map((c) => {
    let slug = slugifyRule(c.rule);
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;

    // Snippets that contain ``` get a wider fence so they can't break out.
    const fence = c.evidence_snippet.includes("```") ? "````" : "```";
    const lang = fenceLangFor(c.evidence_path);
    return [
      `## ${slug}`,
      c.rule,
      "",
      `Detected in \`${evidenceLabel(c)}\`:`,
      "",
      `${fence}${lang}`,
      c.evidence_snippet,
      fence,
    ].join("\n");
  });

  return [
    `# ${name}`,
    "",
    `House conventions for \`${repoFullName}\`. Flag changes that violate any rule below and cite the offending \`file:line\`.`,
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

/** Compact "2m ago"-style relative time for the scan meta line. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
