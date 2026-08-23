/* BlastCard — blast radius of the PR's changes (L04), rendered next to the
   IntentCard on the Overview tab. Header counts (symbols/callers/endpoints/
   crons) + Tree|Graph toggle; Tree = collapsible per-symbol rows → clickable
   file:line callers → endpoint/cron chips; Graph = layered SVG of the same
   data. Footer: prior PRs touching the same files. States: skeleton, empty,
   partial/degraded banners; 4xx stays a silent inline state (client rule). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, SectionLabel, Skeleton } from "@devdigest/ui";
import type { BlastPriorPr, BlastResponse, BlastSymbolImpact } from "@devdigest/shared";
import { usePrBlast } from "@/lib/hooks/blast";
import { githubPrUrl } from "@/lib/github-urls";
import { BlastGraph } from "./_components/BlastGraph";
import { SKELETON_HEIGHT } from "./constants";
import { partitionSymbols, symbolLabel } from "./helpers";
import { s } from "./styles";

type BlastView = "tree" | "graph";

export function BlastCard({
  prId,
  repoFullName,
  onGoToFile,
}: {
  prId: string | null;
  /** "owner/repo" for GitHub deep-links (prior PRs); null until loaded. */
  repoFullName: string | null;
  /** Open a file (optionally at a line) — in-app diff or GitHub fallback. */
  onGoToFile: (file: string, line?: number) => void;
}) {
  const t = useTranslations("blast");
  const { data, isLoading } = usePrBlast(prId);
  const [view, setView] = React.useState<BlastView>("tree");

  if (isLoading) {
    return (
      <section>
        <SectionLabel icon="Zap">{t("title")}</SectionLabel>
        <Skeleton height={SKELETON_HEIGHT} />
      </section>
    );
  }

  // 4xx / network errors land here — queries stay 4xx-silent (inline state).
  if (!data) {
    return (
      <section>
        <SectionLabel icon="Zap">{t("title")}</SectionLabel>
        <div style={s.empty}>
          <p style={s.emptyText}>{t("unavailable")}</p>
        </div>
      </section>
    );
  }

  if (data.status === "empty" || data.status === "degraded") {
    return (
      <section>
        <SectionLabel icon="Zap">{t("title")}</SectionLabel>
        <div style={s.empty}>
          <p style={s.emptyText}>
            {data.status === "empty" ? t("empty") : t("banner.degraded")}
          </p>
          {data.reason && <p style={s.emptyHint}>{data.reason}</p>}
          {data.status === "degraded" && <p style={s.emptyHint}>{t("banner.degradedHint")}</p>}
          {data.prior_prs.length > 0 && (
            <PriorPrs priorPrs={data.prior_prs} repoFullName={repoFullName} />
          )}
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionLabel
        icon="Zap"
        right={
          <div style={s.segmented} role="group" aria-label={t("viewToggle")}>
            {(["tree", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                style={s.segment(view === v)}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {t(`view.${v}`)}
              </button>
            ))}
          </div>
        }
      >
        {t("title")}
      </SectionLabel>

      <div style={s.card}>
        <StatRow counts={data.counts} />

        {data.status === "partial" && (
          <div style={s.banner("partial")}>
            <Icon.AlertTriangle size={13} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
            <span>
              {t("banner.partial")}
              {data.reason && <span style={s.bannerHint}> {data.reason}</span>}
            </span>
          </div>
        )}

        {view === "tree" ? (
          <BlastTree data={data} onGoToFile={onGoToFile} />
        ) : (
          <BlastGraph data={data} onFileClick={(file) => onGoToFile(file)} />
        )}

        <PriorPrs priorPrs={data.prior_prs} repoFullName={repoFullName} />
      </div>
    </section>
  );
}

/** Header counts: symbols / callers / endpoints / cron-jobs. */
function StatRow({ counts }: { counts: BlastResponse["counts"] }) {
  const t = useTranslations("blast");
  const stats = [
    { key: "symbols", value: counts.symbols },
    { key: "callers", value: counts.callers },
    { key: "endpoints", value: counts.endpoints },
    { key: "crons", value: counts.crons },
  ] as const;
  return (
    <div className="tnum" style={s.statRow}>
      {stats.map(({ key, value }) => (
        <span key={key}>
          <span style={s.statValue}>{value}</span>
          {t(`stat.${key}`)}
        </span>
      ))}
    </div>
  );
}

/** Tree view: collapsible per-symbol rows; the first symbol starts expanded. */
function BlastTree({
  data,
  onGoToFile,
}: {
  data: BlastResponse;
  onGoToFile: (file: string, line?: number) => void;
}) {
  const t = useTranslations("blast");
  // Zero-caller symbols carry no impact info (no callers ⇒ no attributed
  // endpoints/crons) — most-called rows first, the rest behind a summary row.
  const { active, silent } = partitionSymbols(data.symbols);
  const firstKey = active[0] ? symbolKey(active[0]) : null;
  const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(
    () => new Set(firstKey ? [firstKey] : []),
  );
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const indirect = data.endpoints.filter((e) => e.depth > 1);

  if (active.length === 0) {
    return <div style={s.noCallers}>{t("noDownstream", { count: data.symbols.length })}</div>;
  }

  return (
    <div style={s.tree}>
      {active.map((sym) => (
        <SymbolRow
          key={symbolKey(sym)}
          impact={sym}
          open={openKeys.has(symbolKey(sym))}
          onToggle={() => toggle(symbolKey(sym))}
          onGoToFile={onGoToFile}
        />
      ))}
      <SilentSymbols symbols={silent} />
      {indirect.length > 0 && (
        <div style={s.indirectRow}>
          <span>{t("indirect")}</span>
          {indirect.map((e) => (
            <span key={`${e.endpoint}|${e.file}`} title={e.file}>
              <Badge mono>{e.endpoint}</Badge>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function symbolKey(sym: BlastSymbolImpact): string {
  return `${sym.symbol.file}|${sym.symbol.name}`;
}

/** One collapsible symbol: `<> name()` + caller count → callers → fact chips. */
function SymbolRow({
  impact,
  open,
  onToggle,
  onGoToFile,
}: {
  impact: BlastSymbolImpact;
  open: boolean;
  onToggle: () => void;
  onGoToFile: (file: string, line?: number) => void;
}) {
  const t = useTranslations("blast");
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        style={s.symbolRow}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
        aria-expanded={open}
      >
        <Icon.ChevronRight size={13} style={s.symbolChevron(open)} />
        <Icon.Code size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span className="mono" style={s.symbolName} title={impact.symbol.file}>
          {symbolLabel(impact.symbol)}
        </span>
        <span className="tnum" style={s.symbolMeta}>
          {t("callerCount", { count: impact.callers.length })}
        </span>
      </div>

      {open && (
        <div style={s.symbolBody}>
          {impact.callers.length > 0 && (
            <ul style={s.callerList}>
              {impact.callers.map((c) => (
                <li key={`${c.file}:${c.line}:${c.symbol}`}>
                  <button
                    type="button"
                    className="mono"
                    style={s.callerBtn}
                    title={`${c.file}:${c.line}`}
                    onClick={() => onGoToFile(c.file, c.line)}
                  >
                    {c.file}:{c.line}
                    <span style={s.callerVia}>({c.symbol})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(impact.endpoints_affected.length > 0 || impact.crons_affected.length > 0) && (
            <div style={s.chipRow}>
              {impact.endpoints_affected.map((e) => (
                <Badge key={e} mono color="var(--warn)">
                  {e}
                </Badge>
              ))}
              {impact.crons_affected.map((c) => (
                <Badge key={c} mono icon="Clock" color="var(--text-secondary)">
                  {c}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Zero-caller symbols, collapsed into one expandable summary row. */
function SilentSymbols({ symbols }: { symbols: BlastSymbolImpact[] }) {
  const t = useTranslations("blast");
  const [open, setOpen] = React.useState(false);
  if (symbols.length === 0) return null;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        style={s.silentHeader}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        <Icon.ChevronRight size={13} style={s.symbolChevron(open)} />
        {t("silentSymbols", { count: symbols.length })}
      </div>
      {open && (
        <ul style={s.silentList}>
          {symbols.map((sym) => (
            <li key={symbolKey(sym)} style={s.silentItem} title={sym.symbol.file}>
              <span className="mono">{symbolLabel(sym.symbol)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Collapsible "Prior PRs touching these files" footer. */
function PriorPrs({
  priorPrs,
  repoFullName,
}: {
  priorPrs: BlastPriorPr[];
  repoFullName: string | null;
}) {
  const t = useTranslations("blast");
  const [open, setOpen] = React.useState(false);
  if (priorPrs.length === 0) return null;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        style={s.priorHeader}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        <Icon.ChevronRight size={13} style={s.symbolChevron(open)} />
        <Icon.GitPullRequest size={13} style={{ color: "var(--text-muted)" }} />
        {t("priorPrs.title")}
        <span className="tnum" style={{ color: "var(--text-muted)", fontWeight: 400 }}>
          {priorPrs.length}
        </span>
      </div>
      {open && (
        <ul style={s.priorList}>
          {priorPrs.map((pr) => (
            <li key={pr.number} style={s.priorItem}>
              {repoFullName ? (
                <a
                  className="mono"
                  style={s.priorNumber}
                  href={githubPrUrl(repoFullName, pr.number)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  #{pr.number}
                </a>
              ) : (
                <span className="mono" style={s.priorNumber}>
                  #{pr.number}
                </span>
              )}
              <span style={s.priorTitle} title={pr.title}>
                {pr.title}
              </span>
              <span style={s.priorMeta}>
                {pr.author} · {pr.status} · {t("priorPrs.overlap", { count: pr.files_overlap.length })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default BlastCard;
