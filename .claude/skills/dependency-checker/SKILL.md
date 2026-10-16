---
name: dependency-checker
description: "Audits dependencies across all 5 DevDigest packages (server, client, reviewer-core, e2e, mcp) and produces a structured Dependency Report: Scope, a repo-level Mermaid diagram distinguishing internal (path-alias/vendored/runtime) relationships from external npm dependencies, per-package size/version tables, severity-tiered findings (P0/P1/P2/Info) covering version drift, unused dependencies, and internal-boundary violations, and a closing Summary of ranked next steps. Use this whenever the user asks about dependency bloat, node_modules size, 'what depends on what', duplicate/conflicting package versions across packages, unused packages, outdated packages, install size, or wants a dependency graph/diagram/audit of the repo — even if they just say 'check our dependencies' or 'why is node_modules so big'."
argument-hint: "[--skip-outdated] [--package <name>]"
---

# Dependency Checker

Produces a full dependency audit of the DevDigest repo: what depends on
what, how much each thing weighs on disk, where the same library has
drifted to different versions across packages, where a dependency is
declared but never used, where a package reaches into another package's
internals instead of its public surface — and what to do about it, ranked.
A developer should be able to read the Scope line, skim the severity
tiers, and read the closing Summary, and already know what to act on
without reading every table in between.

This repo is **not an npm/pnpm workspace** — `server`, `client`,
`reviewer-core`, `e2e`, and `mcp` each have their own `package.json` and
lockfile (see root `CLAUDE.md`). That's exactly why this audit is useful:
nothing stops the same dependency from silently drifting to different
versions in different packages, and nobody sees the size of the whole
picture from any single `package.json`.

## Step 1 — Collect the facts (deterministic, run the script)

Don't hand-parse `package.json` files or shell out to `du` yourself —
`scripts/collect.mjs` already does this correctly (it dereferences pnpm's
symlinked `node_modules/<pkg>` before measuring size, which a naive `du -sh`
gets wrong and reports as ~0 bytes). Run it once from the repo root:

```bash
node .claude/skills/dependency-checker/scripts/collect.mjs .
```

Pass `--skip-outdated` if the user wants a fast/offline run — the script
otherwise shells out to `pnpm outdated --format json` per package, which
hits the npm registry and can take 30-60s total across 5 packages. If a
`--package <name>` argument was given, still run the full collection (the
script doesn't filter) but only render that package's section in Step 5,
plus keep it in the repo-level diagram and duplicate table for context.

The script emits one JSON object with `root`, `packages[]` (each with its
declared deps split by type, installed size, installed version,
`totalNodeModulesSize`, `explicitDepsSize`/`transitiveGapSize`, a
best-effort `usedInSource` flag per **prod** dep, and `outdated` data), and
`duplicates[]` (deps declared in more than one package). Read that JSON —
it's the ground truth for every number in the report. Do not invent or
estimate a size, version, duplicate, or usage claim that isn't in it; if
`sizeHuman` is `null` the dep wasn't installed, say so instead of guessing.

`usedInSource` is a text-pattern match over that package's own source
files (import/require/dynamic-import of the dep name) — treat `false` as
**strong evidence**, not proof (it can miss an import built from a dynamic
string at runtime). Before reporting a dep as unused in Step 6, and
especially before recommending its removal, do a final sanity check on the
codebase if anything about the dependency's role makes a false negative
plausible (e.g. a plugin loaded by name, a peer dependency another
package expects to find).

**One thing the script deliberately does NOT know about:** `@devdigest/shared`
is vendored (copied) into `server/src/vendor/shared` and `client/src/vendor/shared`
as plain source files — it is never an npm dependency, so it will never
appear in the JSON's `deps` lists, and that's correct, not a bug. It
belongs in Step 3's diagram as a **file-copy relationship**, not a
version-pinned package edge.

## Step 2 — Scope

Open the report with a short `## Scope` section — one or two sentences,
not a table — naming exactly which packages were analyzed (`server`,
`client`, `reviewer-core`, `e2e`, `mcp`, or the narrowed set if `--package`
was given) and, in one line, what kind of dependency each package
declares (e.g. "server and client carry the runtime-heavy deps; e2e has
none"). This is what lets a reader confirm the report actually covered
the package they care about before reading further, and it's where you
first name the distinction Step 3 draws in detail: this report treats
**external npm dependencies** (what's in `package.json` + `node_modules`)
and **internal cross-package relationships** (source imports, vendored
copies, runtime calls between the 5 packages) as two different kinds of
thing, not interchangeable "dependencies."

## Step 3 — Repo-level map: internal vs external

Render one `flowchart TD` (or LR) Mermaid diagram showing how the 5
packages relate **internally** — this is deliberately a different graph
from the external npm dependency data in Steps 5-6, because conflating
"imports this code" with "installed this package" is exactly the mistake
this section exists to prevent. Base edges on facts you actually know, not
guesses:

- `reviewer-core` is consumed by `server` as **source**, via a tsconfig
  path alias (see root CLAUDE.md) — not an npm dependency edge.
- `mcp` talks to `server` over HTTP at runtime (thin proxy) — a runtime
  edge, not an install-time one; label it differently (e.g. dashed arrow)
  from the source/vendor edges so a reader doesn't conflate "imports this
  code" with "calls this over the network".
- `server` and `client` each vendor their own copy of `@devdigest/shared` —
  draw both as pointing to a `shared contracts (vendored, not npm)` node,
  and say explicitly in a note under the diagram that these two copies can
  drift out of sync since neither is npm-installed or symlinked.
- `e2e` drives the running `client` app via a browser — another runtime
  edge, not an install-time one.

**Internal-boundary check.** The sanctioned ways one of these packages
reaches into another are exactly the edges drawn above: the tsconfig
alias, the vendored copy, or a runtime call across a real boundary (HTTP,
browser). If you have Grep/Read access (or the prompt already hands you
grep output over cross-package imports), check for a file in one package
importing another package's internals by relative path instead — e.g.
something like `from "../../reviewer-core/src/pipeline.js"` reaching past
reviewer-core's intended entry point, rather than going through the
tsconfig alias reviewer-core is meant to be consumed by. That is a **P0**
finding in Step 6 regardless of how small or well-tested the imported file
is: it works today because the internal file happens to still be there,
and breaks silently the moment reviewer-core's internals get reorganized —
the whole point of a public entry point is that its internals are free to
move. Don't invent this finding without evidence; if no cross-package
import data was given and you have no tool access, skip the check and say
so rather than asserting the codebase is clean.

Add a second small diagram — a `pie` chart titled "node_modules size by
package" using each package's `totalNodeModulesSize` — so the size
imbalance across the 5 packages is visible at a glance before the reader
gets to the detailed tables.

## Step 4 — Size by package

(Covered by the pie chart in Step 3. If the pie chart alone doesn't make
the imbalance legible — e.g. one package so large it flattens the rest —
add a one-line ranked list of packages by `totalNodeModulesSize` under it.)

## Step 5 — Per-package breakdown

For **every** package in the JSON (`server`, `client`, `reviewer-core`,
`e2e`, `mcp`, unless `--package` narrowed it), render this exact structure:

```markdown
### <package dir> (`<package.json name>`)

**node_modules on disk:** <totalNodeModulesSize.human, or "not installed">
(explicit deps account for <explicitDepsSize.human>; the rest —
<transitiveGapSize.human> — is transitive dependencies pulled in underneath
them, not measurement error)

| Dependency | Type | Range | Installed | Size | Shared with |
|---|---|---|---|---|---|
```

Only include the parenthetical transitive-gap line when `transitiveGapSize`
is meaningfully large relative to the total (say, over ~20%) — for a small
package where explicit deps already account for nearly everything, it's
noise. When the gap IS large (as with `mcp` in this repo, where two small
top-level prod deps summed with dev tooling still leave well over half of
`node_modules` unaccounted for), that's worth carrying into Step 6 —
point at `pnpm why <suspect>` as the way to find which top-level dep is
actually pulling in the weight, rather than guessing.

Table rules:
- One row per entry in that package's `deps`. Sort by `sizeBytes` descending
  within each type group (prod first, then dev, then peer) — the point of
  sorting is that the heaviest, most consequential deps are the first thing
  a developer sees, not alphabetical trivia.
- **Installed** column = `installedVersion` (what's actually on disk), which
  can differ from the declared **Range**. If `installed` is false, write
  `not installed` and leave Size blank — don't write "0B", that reads as
  "this weighs nothing" which is false.
- **Shared with** column = other package dirs that also declare this dep
  (from `duplicates[]`), or "—" if it's unique to this package. This is
  what makes the per-package view connect to Step 6 instead of being read
  in isolation.
- If a prod dep's `usedInSource` is `false`, mark the row (e.g. an
  "unused?" note in Shared with, or a superscript) and carry it into Step
  6 as a named finding — don't just leave it as an unexplained row a
  reader has to notice themselves.
- Bold the row for any dep whose size is disproportionate for its role —
  use judgment informed by what the package actually does (e.g. a 40MB dep
  in `mcp`, whose whole job is a thin stdio proxy, is far more notable than
  the same 40MB in `client`, which is expected to carry a framework and a
  chart library). Don't apply a single fixed size threshold across every
  package; a fixed number won't mean the same thing in a 37MB package and a
  700MB one.

`reviewer-core` is expected to have a near-empty `dependencies` list by
design (see root CLAUDE.md — "reviewer-core purity", build is typecheck
only, no runtime deps besides its injected LLM provider contract). If its
prod dependency table is thin, that's the system working, not a gap to
flag — say so briefly instead of padding the section.

## Step 6 — Findings & Priorities

This is the section the rest of the report feeds — every notable thing
from Steps 3-5 gets restated here under an explicit severity tier, grouped
by tier, **not** left as an unranked bullet list. Use exactly these four
tiers:

- **P0** — real risk right now: an internal-boundary violation (Step 3), a
  **major**-version drift on a dependency shared across packages that
  affects runtime behavior, or a prod dependency the package imports but
  that isn't actually installed.
- **P1** — should fix soon, not urgent: **any** version drift (patch,
  minor, or major) on a **prod/runtime** dependency shared across packages
  that isn't already P0 — e.g. three packages resolving three different
  `zod` versions is a P1 even if every gap is patch-level, because a
  validation/schema library can change parsing behavior at any semver
  level, and nothing here is a workspace holding them in sync. Also P1: an
  unused declared dependency (`usedInSource: false`), a major-version
  drift confined to dev-only tooling (e.g. one package testing on
  `vitest@3.x` while its siblings are on `2.x` — a real finding, different
  config/plugin/reporter surface, just lower stakes than a runtime dep),
  and a single dependency that dominates a package's size relative to what
  that package actually does.
- **P2** — low priority: patch/minor version drift confined to dev-only
  tooling across independently-locked packages (expected, low-risk, but
  worth a line so it doesn't look unnoticed) — the dev-tooling exception
  in P1 above does NOT apply here; this tier is specifically for
  patch/minor gaps, not major ones.
- **Info** — a healthy state worth stating explicitly, not just an absent
  finding: e.g. "no drift on any runtime-shared dependency", "reviewer-core's
  thin prod dependency list is the purity design working as intended",
  "e2e has zero prod dependencies, consistent with its role."

Every finding names the exact package(s), dependency name(s), or file —
never generic advice like "consider auditing dependencies." Draw
candidates only from what Steps 1-5 actually surfaced; don't pad a tier to
look thorough, and don't invent a finding that isn't backed by a row or
number above. If a tier is genuinely empty, say so in one line instead of
omitting it — an absent tier without a note reads as "wasn't checked,"
not "checked and clean."

A few finding types map to a tier by default, but use judgment — the list
above is a starting point, not a rulebook that overrides what the actual
data shows:

- Removing a dependency is always phrased as a recommendation **for the
  user to confirm**, never as something already done — this report reads
  files, it doesn't edit them.
- Packages `pnpm outdated` reported as far behind (`current` vs `latest`
  major-version gaps especially) — cite the actual current→latest numbers
  from the JSON, and skip this finding type gracefully if `outdated` came
  back as `{ "__error": ... }` (no network) rather than reporting "no
  outdated packages found," which would be a false claim.

## Step 7 — Summary

Close with a `## Summary` section distinct from Step 6: **3-5 concrete,
actionable takeaways**, ordered by priority (highest first), each one
sentence naming the specific package/dependency and the action. This is
the "if you read nothing else" distillation of the P0/P1 findings above —
not a restatement of every finding, and not generic advice. If Step 6
surfaced fewer than 3 real findings, don't pad the Summary to hit a
count — list what's genuinely actionable, even if that's only one or two
items, plus a line noting the overall dependency health is otherwise
sound.

## Notes for accuracy

- Every number in the report must trace back to the JSON from Step 1. If
  you're about to write a size, version, "shared with" list, or usage
  claim from memory or estimation instead of reading it off the collected
  JSON, stop and re-check the JSON instead.
- `pnpm`'s content-addressable store means the *marginal* disk cost of an
  already-shared package across packages on this machine is lower than the
  raw sizes suggest (pnpm hardlinks from a global store) — mention this
  once, briefly, near the size diagram so the numbers aren't misread as "we
  could reclaim all of this disk space," which isn't quite true. The sizes
  are still the right signal for *install/audit surface* and *version
  drift risk*, which is what this report is actually for.
