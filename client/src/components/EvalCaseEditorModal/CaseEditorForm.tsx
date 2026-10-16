/* CaseEditorForm — screen F's body and footer (spec §10 F).

   A local sub-part of EvalCaseEditorModal, never exported from the folder: the
   container owns the query and remounts this component per case, which is what
   lets the draft be seeded ONCE in `useState` initialisers with no
   `useEffect` sync.

   Everything else is DERIVED during render, never stored:
     - JSON validity (AC-14) and the disabled Save,
     - the `must_find` hunk warnings (AC-13),
     - the empty-diff notice, the provenance state, the last-run strip.
   The rules themselves live in `helpers.ts`, not in this body. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  FormField,
  Icon,
  Modal,
  Tabs,
  Textarea,
  TextInput,
  Toggle,
} from "@devdigest/ui";
import type { EvalCaseDraft, EvalCaseRecord, EvalRunResult } from "@devdigest/shared";
import {
  useCreateEvalCase,
  useCreateEvalCaseFromFinding,
  useDeleteEvalCase,
  useRunDraftEvalCase,
  useRunEvalCase,
  useUpdateEvalCase,
} from "@/lib/hooks/eval";
import {
  BODY_ROWS,
  DIFF_ROWS,
  EXPECTED_ROWS,
  INPUT_TABS,
  JSON_INDENT,
  MODAL_WIDTH,
  type InputTab,
} from "./constants";
import {
  draftFromCaseDraft,
  draftFromRecord,
  draftToFindingInput,
  draftToInput,
  findExpectationWarnings,
  parseExpectedOutput,
  readCaseHasRunsCount,
  scanDiffHunks,
  sourceFindingState,
  withFindingSkeleton,
} from "./helpers";
import { s } from "./styles";

export interface CaseEditorFormProps {
  /** The persisted case, or `null` for a brand-new one. */
  record: EvalCaseRecord | null;
  /**
   * Server-composed, UNSAVED draft (C24) when authoring from a finding. Mutually
   * exclusive with `record`: the container passes at most one.
   */
  seedDraft?: EvalCaseDraft | null;
  /** Finding this case is authored from — makes Save post R1 instead of R4. */
  sourceFindingId?: string | null;
  /** PR whose `["pr-eval-cases", prId]` cache must show the new link on save. */
  prId?: string | null;
  /**
   * Owning agent uuid. Optional because the "Turn into eval case" path does not
   * know the owner until the draft loads — it is then read off the draft, and
   * the persisted record is authoritative once there is one.
   */
  agentId?: string | null;
  /** Repo of the source finding's PR; routes need it, `input_meta` does not carry it. */
  repoId?: string | null;
  onClose: () => void;
  onSaved?: (record: EvalCaseRecord) => void;
}

export function CaseEditorForm({
  record,
  seedDraft,
  sourceFindingId,
  prId,
  agentId,
  repoId,
  onClose,
  onSaved,
}: CaseEditorFormProps) {
  const t = useTranslations("eval");

  // The owner, most authoritative first: a persisted case owns itself, a draft
  // carries the agent the finding's review ran under, and only a hand-authored
  // "+ New case" falls back to the caller's agent.
  const ownerId = record?.owner_id ?? seedDraft?.owner_id ?? agentId ?? "";

  // --- state: only what the user actually types or picks -------------------
  // Seeded ONCE: the container remounts this component per case (`key`), so a
  // `useEffect` that syncs props into state is neither needed nor allowed.
  const [seed] = React.useState(() =>
    seedDraft ? draftFromCaseDraft(seedDraft) : draftFromRecord(record),
  );
  const [name, setName] = React.useState(seed.name);
  const [diff, setDiff] = React.useState(seed.diff);
  const [metaTitle, setMetaTitle] = React.useState(seed.metaTitle);
  const [metaBody, setMetaBody] = React.useState(seed.metaBody);
  const [expectedText, setExpectedText] = React.useState(seed.expectedText);
  const [tab, setTab] = React.useState<InputTab>(INPUT_TABS[0]);
  /** Q6 — per-modal-session default `off`; deliberately not persisted. */
  const [runOnSave, setRunOnSave] = React.useState(false);
  /** Set only by a 409 `case_has_runs`; `null` means "no confirmation pending". */
  const [pendingRunCount, setPendingRunCount] = React.useState<number | null>(null);

  /** The last run made in THIS modal session — saved or draft. */
  const [runResult, setRunResult] = React.useState<EvalRunResult | null>(null);

  const create = useCreateEvalCase();
  const createFromFinding = useCreateEvalCaseFromFinding();
  const runDraft = useRunDraftEvalCase();
  const update = useUpdateEvalCase();
  const remove = useDeleteEvalCase();
  const run = useRunEvalCase();

  // --- derived during render (never mirrored into state) -------------------
  const parsed = parseExpectedOutput(expectedText);
  const scan = scanDiffHunks(diff);
  const warnings = findExpectationWarnings(parsed.ok ? parsed.value : null, scan);
  // An untouched, empty diff on a brand-new case is not yet a mistake — only
  // text that fails to yield a file is.
  const showEmptyDiff = diff.trim().length > 0 && scan.files.length === 0;
  const provenance = sourceFindingState(record, repoId);
  const lastRun = record?.last_run ?? null;

  const saving = create.isPending || createFromFinding.isPending || update.isPending;
  const canSave = parsed.ok && name.trim().length > 0 && !saving;

  /** Drives the banner. An unparseable blob keeps the last known kind's frame
      rather than flipping the banner while the user is mid-edit. */
  const kind = parsed.ok ? parsed.value.kind : (seedDraft?.expected_output.kind ?? record?.expected_output.kind ?? "must_find");

  const running = run.isPending || runDraft.isPending;
  // A draft run needs an agent to run AGAINST; a saved case brings its own.
  const canRun = parsed.ok && diff.trim().length > 0 && !running && (record != null || ownerId !== "");

  const actualText = runResult
    ? JSON.stringify(runResult.result.per_trace[0]?.actual ?? [], null, JSON_INDENT)
    : "";
  const actualMeta = runResult ? (
    <span style={s.lastRunMeta}>
      {t("caseEditor.resultSummary", {
        recall: Math.round(runResult.result.recall * 100),
        precision: Math.round(runResult.result.precision * 100),
        citation: Math.round(runResult.result.citation_accuracy * 100),
        duration: (runResult.result.duration_ms / 1000).toFixed(1),
      })}
    </span>
  ) : null;

  const subtitle = seedDraft
    ? t(
        seedDraft.expected_output.kind === "must_not_flag"
          ? "caseEditor.seededFromDismissed"
          : "caseEditor.seededFromAccepted",
      )
    : record
      ? t("caseEditor.editSubtitle")
      : t("caseEditor.newSubtitle");

  // --- actions -------------------------------------------------------------
  const onSave = () => {
    // Save is disabled while either guard fails (AC-14); re-checked here so the
    // handler can narrow `parsed` and never posts an unvalidated blob.
    if (!parsed.ok || name.trim().length === 0) return;
    const draft = { name, diff, metaTitle, metaBody, expectedText };
    const done = (saved: EvalCaseRecord) => {
      onSaved?.(saved);
      // "Run on save" fires the run and closes; its own invalidations refresh
      // the case list behind the modal with the new last-run strip.
      if (runOnSave) run.mutate({ caseId: saved.id, agentId: saved.owner_id });
      onClose();
    };
    if (record) {
      const body = draftToInput(draft, parsed.value, record.owner_id, record);
      update.mutate({ caseId: record.id, patch: body }, { onSuccess: done });
      return;
    }
    // Authored FROM a finding: R1 is the only route that mints provenance
    // (`source_finding_id`), which is what makes the finding card's created
    // state and the server's idempotency guard work. R4 hard-codes it to null.
    if (sourceFindingId && seedDraft) {
      const body = draftToFindingInput(draft, parsed.value, seedDraft);
      createFromFinding.mutate(
        { findingId: sourceFindingId, ...(prId ? { prId } : {}), body },
        { onSuccess: done },
      );
      return;
    }
    create.mutate(draftToInput(draft, parsed.value, ownerId, null), { onSuccess: done });
  };

  /**
   * Run WITHOUT saving when the case has no row yet (R8b) — the point of the
   * button in the create flow: see what the agent does before committing the
   * case to its set. A saved case runs through R8 and records a row as before.
   */
  const onRun = () => {
    if (!parsed.ok) return;
    if (record) {
      run.mutate({ caseId: record.id, agentId: ownerId }, { onSuccess: setRunResult });
      return;
    }
    if (ownerId === "") return;
    runDraft.mutate(
      {
        agentId: ownerId,
        body: {
          name: name.trim() || "draft",
          input_diff: diff,
          input_meta: { title: metaTitle || null, body: metaBody || null },
          expected_output: parsed.value,
        },
      },
      { onSuccess: setRunResult },
    );
  };

  const onDelete = (force: boolean) => {
    if (!record) return;
    remove.mutate(
      { caseId: record.id, agentId: ownerId, force },
      {
        onSuccess: () => onClose(),
        onError: (error) => {
          const count = readCaseHasRunsCount(error);
          if (count != null) setPendingRunCount(count);
        },
      },
    );
  };

  // --- footer ---------------------------------------------------------------
  const footer = (
    <div style={s.footer}>
      <Button kind="tertiary" onClick={onClose}>
        {t("caseEditor.cancel")}
      </Button>
      {record && (
        <Button kind="danger" icon="Trash" onClick={() => onDelete(false)}>
          {t("caseEditor.delete")}
        </Button>
      )}
      <div style={s.footerSpacer} />
      <label style={s.runOnSave}>
        <Toggle on={runOnSave} onChange={setRunOnSave} size={14} />
        {t("caseEditor.runOnSave")}
      </label>
      <Button
        kind="secondary"
        icon="Play"
        disabled={!canRun}
        loading={running}
        onClick={onRun}
      >
        {running ? t("caseEditor.running") : t("caseEditor.runCase")}
      </Button>
      <Button kind="primary" icon="Check" disabled={!canSave} loading={saving} onClick={onSave}>
        {saving ? t("caseEditor.saving") : t("caseEditor.save")}
      </Button>
    </div>
  );
  return (
    <Modal
      width={MODAL_WIDTH}
      title={record ? t("caseEditor.caseTitle", { name: record.name }) : t("caseEditor.newCase")}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
    >
      {/* Two columns, per the screen F design: the INPUT the agent sees on the
          left, the two OUTPUTS — what we assert and what came back — stacked on
          the right, so expected and actual read side by side. */}
      <div style={s.grid}>
        <div style={s.col}>
          {/* What this case asserts, stated before anything else: a reviewer
              opening a case from a dismissed finding must see "MUST NOT flag"
              without decoding the JSON on the other side. */}
          <div style={s.kindBanner(kind)} role="status">
            <div style={s.kindBannerTitle}>
              {kind === "must_not_flag"
                ? t("caseEditor.kindBanner.negativeTitle")
                : t("caseEditor.kindBanner.positiveTitle")}
            </div>
            <div style={s.kindBannerBody}>
              {kind === "must_not_flag"
                ? t("caseEditor.kindBanner.negativeBody")
                : t("caseEditor.kindBanner.positiveBody")}
            </div>
          </div>

          {provenance.kind === "linked" && (
            <div style={s.note}>
              <Icon.Link size={13} />
              <Link href={provenance.href} style={s.link}>
                {t("caseEditor.sourceFinding")}
              </Link>
            </div>
          )}
          {provenance.kind === "plain" && (
            <div style={s.note}>
              <Icon.Link size={13} />
              {t("caseEditor.sourceFinding")}
            </div>
          )}
          {provenance.kind === "gone" && (
            <div style={s.note}>
              <Icon.Info size={13} />
              {t("caseEditor.sourceFindingGone")}
            </div>
          )}

          <FormField label={t("caseEditor.nameLabel")} required>
            <TextInput
              mono
              value={name}
              onChange={setName}
              placeholder={t("caseEditor.namePlaceholder")}
              aria-label={t("caseEditor.nameLabel")}
            />
          </FormField>

          <FormField label={t("caseEditor.inputLabel")}>
            <Tabs
              pad="0"
              value={tab}
              onChange={(k) => setTab(k as InputTab)}
              tabs={INPUT_TABS.map((key) => ({ key, label: t(`caseEditor.tabs.${key}`) }))}
            />
            <div style={s.tabPanel}>
              {tab === "diff" ? (
                <>
                  <Textarea
                    mono
                    rows={DIFF_ROWS}
                    value={diff}
                    onChange={setDiff}
                    placeholder={t("caseEditor.diffPlaceholder")}
                  />
                  {showEmptyDiff && (
                    <div style={s.warnBlock} role="status">
                      <div style={s.warn}>
                        <Icon.AlertTriangle size={13} style={s.warnIcon} />
                        <span>{t("caseEditor.emptyDiff")}</span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={s.metaField}>
                    <FormField label={t("caseEditor.titleLabel")}>
                      <TextInput
                        value={metaTitle}
                        onChange={setMetaTitle}
                        placeholder={t("caseEditor.titlePlaceholder")}
                        aria-label={t("caseEditor.titleLabel")}
                      />
                    </FormField>
                  </div>
                  <FormField label={t("caseEditor.bodyLabel")}>
                    <Textarea
                      rows={BODY_ROWS}
                      value={metaBody}
                      onChange={setMetaBody}
                      placeholder={t("caseEditor.bodyPlaceholder")}
                    />
                  </FormField>
                </>
              )}
            </div>
          </FormField>
        </div>

        <div style={s.col}>
          <FormField
            label={t("caseEditor.expectedOutput")}
            right={
              <div style={s.labelRow}>
                {/* WCAG: the badge always pairs a glyph WITH text — never colour alone. */}
                <span aria-live="polite">
                  <Badge
                    icon={parsed.ok ? "Check" : "AlertTriangle"}
                    color={parsed.ok ? "var(--ok)" : "var(--crit)"}
                  >
                    {parsed.ok ? t("caseEditor.validJson") : t("caseEditor.invalidJson")}
                  </Badge>
                </span>
                <Button
                  kind="tertiary"
                  size="sm"
                  onClick={() => setExpectedText(withFindingSkeleton(expectedText, scan))}
                >
                  {t("caseEditor.findingSkeleton")}
                </Button>
              </div>
            }
          >
            <Textarea
              mono
              rows={EXPECTED_ROWS}
              value={expectedText}
              onChange={setExpectedText}
              placeholder={t("caseEditor.expectedOutput")}
            />
            {warnings.length > 0 && (
              <div style={s.warnBlock} role="status">
                {warnings.map((w) => (
                  <div key={`${w.file}:${w.start}-${w.end}`} style={s.warn}>
                    <Icon.AlertTriangle size={13} style={s.warnIcon} />
                    <span>
                      {t("caseEditor.expectationNotInDiff", {
                        file: w.file,
                        start: w.start,
                        end: w.end,
                      })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </FormField>

          {/* What the agent actually returned. Read-only and populated only by a
              run in THIS session: `last_run` (C5) carries counts, not findings,
              so claiming to show a previous run's output would be a fiction. */}
          <FormField label={t("caseEditor.actualOutput")} right={actualMeta}>
            {/* A `<pre>`, not a disabled Textarea: this is output, never input,
                and the vendored Textarea has no read-only mode to borrow. */}
            <pre
              style={runResult ? s.actualBox : { ...s.actualBox, ...s.actualEmpty }}
              aria-label={t("caseEditor.actualOutput")}
              aria-live="polite"
            >
              {runResult ? actualText : t("caseEditor.neverRunYet")}
            </pre>
          </FormField>

          {lastRun && !runResult && (
            <div style={s.lastRun}>
              {lastRun.pass === true && (
                <Icon.CheckCircle size={14} style={{ color: "var(--ok)" }} />
              )}
              {lastRun.pass === false && <Icon.XCircle size={14} style={{ color: "var(--crit)" }} />}
              {lastRun.pass === null && <Icon.Info size={14} style={{ color: "var(--text-muted)" }} />}
              {lastRun.pass !== null && (
                <span>
                  {lastRun.pass ? t("caseEditor.lastRunPassed") : t("caseEditor.lastRunFailed")}
                </span>
              )}
              <span style={s.lastRunMeta}>
                {t("evalsTab.expectedGot", {
                  expected: lastRun.expected_count,
                  actual: lastRun.produced_count,
                })}
              </span>
            </div>
          )}

          {pendingRunCount != null && (
            <div style={s.confirm} role="alert">
              <span>{t("caseEditor.deleteConfirmWithRuns", { count: pendingRunCount })}</span>
              <Button kind="tertiary" onClick={() => setPendingRunCount(null)}>
                {t("caseEditor.cancel")}
              </Button>
              <Button kind="danger" icon="Trash" onClick={() => onDelete(true)}>
                {t("caseEditor.delete")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
