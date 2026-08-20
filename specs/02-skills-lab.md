# 02 — Skills Lab (L02): reusable skills for review agents

Status: **spec — not implemented**. Cross-package (server + client + seed); reviewer-core
needs **no changes**. Rev 2 — updated to the 2026-08-18 designs (master-detail Skills
page with Config / Preview / Stats / Versions tabs).

A *skill* is a reusable markdown instruction block. Skills live in the DB (source of
truth), are edited in the UI, and are shared across agents: each agent links an ordered
subset, and enabled linked skills are appended to the agent's prompt as the
`## Skills / rules` block. Skills carry **only configuration text** — nothing executable.

---

## 1. Current state (already in the codebase — do not rebuild)

| Piece | Where | State |
|---|---|---|
| Tables `skills`, `skill_versions`, `agent_skills(order)` | `server/src/db/schema/{skills,agents}.ts`, migration `0000_init.sql` | ✅ exists |
| Contracts `Skill`, `SkillType`, `SkillSource`, `AgentSkillLink`, `AgentVersionConfig.skills` | `*/vendor/shared/contracts/knowledge.ts` (both copies) | ✅ exists — **frozen**, do not edit |
| Agent-side link endpoints `GET/POST /agents/:id/skills` (set / reorder / link-one) | `server/src/modules/agents/{routes,service,repository}.ts` | ✅ exists |
| Engine support: `ReviewInput.skills?: string[]` → `## Skills / rules` block + `trace.prompt_assembly.skills` + token accounting | `reviewer-core/src/{review/run.ts,prompt.ts}` | ✅ exists |
| Trace UI renders the skills block | `RunTraceDrawer/_components/TraceBody.tsx:76` | ✅ exists |
| i18n scaffolding | `client/messages/en/skills.json` | ✅ partial |
| Nav active-section helper expects `/skills` | `client/src/components/app-shell/helpers.ts:33` | ✅ hook point |
| `.claude/skills/pr-self-review` (manual invoke, no auto-trigger) | repo tooling | ✅ exists — verification item only |

**Missing (= the work):** server `skills/` module (CRUD + versioning + usage + import),
one small migration (`skill_versions.note`), skill resolution in `run-executor.ts`
(today it never passes `skills` to the engine), the master-detail `/skills` UI, the
AgentEditor **Skills** tab, nav entry, seed data + the new agent.

## 2. Decisions (agreed 2026-08-18)

1. **Import formats:** a single `.md` file **or** a Claude-style `.zip` containing
   `SKILL.md` (frontmatter `name` / `description`). Everything else in the archive
   (scripts, binaries, extra files) is listed in the preview as *skipped* and never
   read, executed, or stored.
2. **Imported skills get `source: 'community'`** — the `SkillSource` enum is frozen;
   `community` matches the trust narrative ("someone else's instructions in your
   agent's prompt").
3. **Imported skills are created `enabled: false`** ("needs vetting"). Manual skills
   default `enabled: true`.
4. **Enabled semantics — membership + global switch:**
   - Checkbox in the agent's Skills tab = row exists in `agent_skills` (membership).
   - Toggle on the `/skills` list card / Config tab = global `skills.enabled`
     kill-switch.
   - Prompt gets skills that are **linked AND globally enabled**, ordered by
     `agent_skills.order`.
5. **One new agent:** **Test Quality Reviewer** with **3–4 skills** (at least one of
   them brought in through the import flow). No API Contract agent.
6. Import from **URL** and the **community catalog** are OUT of scope.
7. **Evals tab / "Run on evals" are NOT rendered at all** in this scope (no TABS
   entry, no button) — they arrive with the eval lesson.
8. **Stats tab is minimal-honest:** only data derivable today — "Used by N agents" +
   the list of those agents with Open links. Pull-frequency / accept-rate / findings
   donut from the design need per-run skill attribution that doesn't exist; they render
   as "coming later" placeholders. List cards show `N agents`, not %-metrics.
9. **Versions get a `note`:** new migration adds nullable `skill_versions.note`; a
   body-save may carry an optional "what changed" note. Diff is computed client-side;
   Restore = save an old body as the newest version (no new endpoint).

## 3. Server

### 3.1 Migration (the only schema change)

Add `note: text('note')` (nullable) to `skill_versions` in
`server/src/db/schema/skills.ts`, generate via `pnpm db:generate` (never edit applied
SQL in `src/db/migrations/*`).

### 3.2 New module `server/src/modules/skills/` (routes → service → repository)

Mirror the `agents/` module structure (`constants.ts`, `helpers.ts`, `repository.ts`,
`service.ts`, `routes.ts`). Register statically in `modules/index.ts`. All queries
workspace-scoped via `getContext()`.

| Route | Behavior |
|---|---|
| `GET /skills` | List for workspace, newest first. DTO = shared `Skill`. |
| `GET /skills/:id` | One skill or 404 `NotFoundError`. |
| `GET /skills/usage` | Usage map for list cards + Stats tab: `[{skill_id, agents: [{id, name}]}]` from `agent_skills ⋈ agents` (workspace-scoped). New contract file `contracts/skills-usage.ts` (shared is extended with **new** files only). |
| `POST /skills` | Create. Body: `{name, description, type, body, enabled?, source?}` (source defaults `manual`; import confirm posts `community`). `version = 1`, snapshot row in `skill_versions` (`note: 'Initial version'`). |
| `PUT /skills/:id` | Update. Body additionally accepts optional `note`. A change to `body` bumps `version` and inserts a `skill_versions` snapshot with the note; `enabled`/`name`/`description`/`type`-only changes do **not** bump (same split agents use). Restore from the UI is just this route with an old body + a "Restored from vN" note. |
| `DELETE /skills/:id` | Delete; `agent_skills` links cascade. |
| `GET /skills/:id/versions` | History, newest first: `{version, note, created_at, body}` (bodies included — the client diffs locally). New contract `SkillVersion` in `contracts/skills-usage.ts` (or a sibling new file). |
| `GET /skills/:id/versions/:v` | One snapshot. |
| `POST /skills/import` | Parse-only preview — **persists nothing** (see 3.3). |

Description field is the skill's *interface* — the UI hint says to phrase it as a
directive; the server only requires non-empty.

### 3.3 Import endpoint — `POST /skills/import`

- New deps: `@fastify/multipart` and **`fflate`** (`unzipSync`; zero-dep) for archives.
- Accepts one file field. Dispatch on filename/magic bytes:
  - `.md` → the whole file is the skill body.
  - `.zip` → locate `SKILL.md` at the root or inside a single top-level directory;
    `ValidationError` if absent. **All other entries are only *named* in the response
    (`skipped: string[]`) — their contents are never extracted.**
- Frontmatter: optional YAML block at the top of `SKILL.md`; parse only `name` and
  `description` with a minimal line-based parser (values are plain strings). Strip the
  frontmatter from the returned body. Fallbacks: `name` ← first `# heading` ←
  filename; `description` ← first paragraph (truncated).
- Limits: `.md` ≤ 256 KB; `.zip` ≤ 2 MB compressed, `SKILL.md` entry ≤ 256 KB
  uncompressed (zip-bomb guard: check declared size before inflate).
- Response (new contract file `contracts/skills-import.ts`, vendored to both copies):

  ```ts
  export const SkillImportPreview = z.object({
    name: z.string(),
    description: z.string(),
    body: z.string(),            // markdown, frontmatter stripped
    suggested_type: SkillType,   // heuristic: 'custom' unless keywords match
    skipped: z.array(z.string()),// archive entries we refused to process
    warnings: z.array(z.string()),
  });
  ```

- Saving happens **only** when the user confirms: the client then calls the normal
  `POST /skills` with `source: 'community'`, `enabled: false`. The import endpoint is
  side-effect-free and trivially testable.

### 3.4 Wire skills into review runs (`modules/reviews/run-executor.ts`)

- Per server convention, cross-module access goes through the container: expose a
  narrow lazy getter `container.skillsRepo` (with `resolveAgentSkills(agentId)`) in
  `platform/container.ts`.
- Before `reviewPullRequest(...)`: load the agent's linked skills (ordered), keep
  `enabled === true`, format each body as `### <name>\n<body>`, and pass
  `skills: string[]` (omit when empty — engine already omits the section).
- `runLog.info` line: `Skills: N injected, M skipped (disabled)` — the "enabled skill
  visible in logs, disabled not" acceptance item; the persisted trace gets the block +
  token deltas for free via `outcome.assembly`.
- The failure-path `traceFromBuffer` keeps `skills: null` (no assembly happened).

### 3.5 Seed (`server/src/db/seed.ts` — idempotent, same name-guard as agents)

- Skills (workspace-scoped, `source: 'manual'`):
  1. `branch-coverage-rubric` (type `rubric`) — uncovered branches / missing negative paths.
  2. `corner-case-checklist` (type `rubric`) — boundary values, empty/oversized inputs, concurrency.
  3. `mock-overuse-gate` (type `convention`) — flags tests that mock the unit under test / assert on mocks.
  4. *(4th — `flaky-test-patterns`, type `custom`)* — **not seeded**; shipped as the
     import fixture so the demo path "import → preview → confirm → link" is exercised.
- Agent **Test Quality Reviewer** (provider/model = same defaults as the other seeded
  agents): system prompt targeting test quality — uncovered branches, missing corner
  cases, over-mocking, flaky patterns; `ci_fail_on: 'warning'`. Linked to skills 1–3 in
  that order.
- Import fixtures committed under `server/test/fixtures/skill-import/`:
  `flaky-test-patterns.md` (with frontmatter) and `flaky-test-patterns.zip`
  (SKILL.md + a decoy `install.sh` to demonstrate skipped entries). The zip doubles as
  a hermetic-test fixture.

### 3.6 Server tests

- Hermetic (`skills-import.test.ts`): md frontmatter parse + fallbacks; zip →
  `SKILL.md` found at root / in subdir / missing; decoy `install.sh` lands in
  `skipped`, its content untouched; size-limit rejections.
- Hermetic (`skills-service.test.ts`): body edit bumps version + snapshot with note;
  enabled-toggle doesn't bump; restore-style PUT creates a new version.
- Integration (`skills.it.test.ts`): CRUD roundtrip; `/skills/usage` join; link to
  agent via existing `POST /agents/:id/skills`; "resolve for run" query returns
  linked ∧ enabled, ordered.

## 4. Client

**Layout = master-detail, mirroring the Agents pages** (per the updated designs): a
persistent Skills list column on the left, the selected skill's detail on the right.
All per existing conventions (fetch only in `lib/api.ts`; hooks in
`lib/hooks/skills.ts`; folder-per-component; inline `styles.ts` with `var(--…)` tokens;
i18n via `messages/en/skills.json` + `agents.json`).

### 4.1 Hooks (`lib/hooks/skills.ts`)

`useSkills`, `useSkill(id)`, `useSkillsUsage`, `useSkillVersions(id)`,
`useCreateSkill`, `useUpdateSkill` (accepts optional `note`), `useDeleteSkill`,
`useImportSkillPreview` (multipart — extend `api.ts` with an `upload` helper that
skips the JSON content-type), plus agent-side `useAgentSkills(agentId)` /
`useSetAgentSkills(agentId)`. Query keys: `["skills"]`, `["skill", id]`,
`["skills-usage"]`, `["skill-versions", id]`, `["agent-skills", agentId]`; invalidate
`["agents"]`/`["agent", id]` on link changes.

### 4.2 Routes & structure (`app/skills/`)

- `layout.tsx` — breadcrumb `Skills Lab › Skills` + the list column (§4.3) + detail
  slot.
- `page.tsx` — empty detail state: "Select a skill" prompt (i18n exists).
- `[id]/page.tsx` — detail view with tabs (§4.4); tab state in `?tab=` (same pattern
  as AgentEditor).
- `new/page.tsx` — blank Config form; on create → redirect to `/skills/[id]`.

### 4.3 List column (`SkillsList`)

- Header: **Skills** + **Add Skill ▾** (`Dropdown`): *Create manually* → `/skills/new`;
  *Import from file* → import modal (§4.5). Search input filters client-side.
- Card per skill (active card highlighted): sparkle icon, mono name, **global enabled
  `Toggle`** (optimistic `PUT {enabled}`), description (truncated), type `Badge`
  (rubric/convention/security/custom) + source badge with icon
  (Manual ✎ / Extracted / Community ⊕ / Imported ↗), footer stat `N agents` from
  `useSkillsUsage` (no %-metrics — decision 8). `needs vetting` chip when
  `source !== 'manual' && !enabled`.

### 4.4 Detail view (`SkillDetail`) — tabs `Config | Preview | Stats | Versions`

Header: icon + mono name + type badge + `v{n}` chip. **No "Run on evals" button, no
Evals tab** (decision 7).

- **Config** (default): `Enabled` toggle (top-right), Name*, Description (hint: *"The
  description is the skill's interface — write it as a directive for the agent"*),
  Type (`SelectInput`), **Skill body*** — editor chrome per design: header bar with
  `<slug>.md` filename chip, an `unsaved` chip when dirty, and a live `~N tokens`
  counter (client-side `js-tiktoken` estimate — same lib the server already uses);
  body = `Textarea` with a line-number gutter (simple overlay component, no editor
  dep). Save = create/update; when the body changed, the save flow asks for an
  optional one-line version note. Delete with confirm (existing dialog behavior).
- **Preview**: subtitle *"Rendered as the reviewing agent receives it"*; the body
  rendered with the kit `Markdown` component (react-markdown + gfm) inside a card.
- **Stats** (minimal-honest, decision 8): stat card **Used by: N agents** + panel
  **Agents using this skill** — rows with agent name and an **Open** link to
  `/agents/[id]`. Pull frequency / accept rate / findings-by-category render as
  disabled placeholder cards labeled "coming with run attribution".
- **Versions**: caption *"Every save snapshots the body…"*; list from
  `useSkillVersions`, newest first: `v{n}` badge, note (fallback "Body updated"),
  date, `Current` chip on the head version; **Diff** — modal with a client-side line
  diff vs the previous version (small pure helper in `helpers.ts`, LCS over lines —
  no dependency); **Restore** — confirm → `PUT /skills/:id` with the snapshot body and
  note `Restored from v{n}` → becomes the new head version.

### 4.5 Import flow (modal from the list column)

File input (`.md,.zip`) → `useImportSkillPreview` → preview step: parsed name /
description / type (editable), rendered body, **skipped entries + warnings listed
explicitly** ("these files were not processed"). Confirm → `POST /skills`
(`source: 'community'`, `enabled: false`) → toast "disabled until vetted" → navigate
to `/skills/[id]`. Cancel discards — nothing was persisted server-side.

### 4.6 AgentEditor **Skills** tab

- Add `{key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles"}` to
  `AgentEditor/constants.ts` and render `SkillsTab` beside `ConfigTab`.
- Rows = **all** workspace skills: checkbox (membership), mono name, type badge;
  globally-disabled skills rendered muted with a `disabled` badge (linkable but inert).
- Ordering: linked rows first, draggable via native HTML5 drag events (no new dep);
  caption *"Order matters — earlier skills appear earlier in the assembled prompt."*
  Header chip `X of Y enabled`. Filter input.
- Every change posts the full ordered set `POST /agents/:id/skills {skill_ids}`
  (endpoint already exists), then invalidates agent queries.

### 4.7 Nav

Add to `vendor/ui/nav.ts` `NAV`: section **SKILLS LAB** with
`{key: "skills", label: "Skills", icon: "Sparkles", href: "/skills", gKey: "s"}`
(config extension, not a primitive fork); move nothing else. `helpers.ts:33` already
maps the pathname. Add the `g s` shortcut row to `SHORTCUTS`.

### 4.8 i18n & client tests

Extend `skills.json` (list card, tabs, config editor chrome, stats placeholders,
versions strings, import preview) and `agents.json` (editor.tabs.skills + tab
strings). Component tests (vitest + jsdom, fetch mocked): SkillsList toggle + search,
Config save (version-note prompt on body change), Versions diff/restore payloads,
import modal preview/confirm, SkillsTab link/reorder payloads.

## 5. Acceptance (maps 1:1 to the lesson checklist)

1. Skill is created **and** edited in the UI; body edit produces a new version visible
   in the Versions tab (with note, Diff, Restore).
2. Test Quality Reviewer exists with 3–4 linked ordered skills; ≥1 arrived via import.
3. Run with an enabled linked skill → trace `prompt_assembly.skills` shows the block
   (own section in RunTraceDrawer, token count included); disable the skill globally →
   rerun → block absent and log says `skipped (disabled)`.
4. Import: `.zip` with `install.sh` decoy → preview lists it under "skipped", nothing
   executed; save only after confirm; imported skill starts disabled.
5. Control experiment (Test Quality Reviewer): PR whose test covers only the happy
   path — run with skills unlinked/disabled → no finding; with skills → flags the
   uncovered branch + a boundary case. Reproducible from seed + fixture.
6. `.claude/skills/pr-self-review` — manual invoke pulls both frontend and backend
   skills (verification only; no product code).

## 6. Sequencing

1. Migration (`skill_versions.note`) + server `skills/` module + tests (§3.1–3.2, §3.6).
2. Container getter + run-executor wiring + log line (§3.4).
3. Import endpoint + fixtures (§3.3).
4. Client data layer (§4.1) → skills layout, list, detail tabs (§4.2–4.4).
5. Import modal + AgentEditor Skills tab + nav + i18n (§4.5–4.8).
6. Seed: skills + Test Quality Reviewer (§3.5).
7. Manual pass over §5; then link this spec from root `CLAUDE.md` "Read when".

## 7. Out of scope

Evals tab + "Run on evals" (eval lesson) · pull-frequency / accept-rate / findings
donut and any per-run skill attribution (`run_skills` tracking — later) · import from
URL · community catalog search · per-agent enable override (membership model instead) ·
auto-invoked pr-self-review (L06 Stop hook).
