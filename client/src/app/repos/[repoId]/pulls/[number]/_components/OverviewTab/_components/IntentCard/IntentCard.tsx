/* IntentCard — declared PR intent & scope (L03), rendered above the PR
   description on the Overview tab. Quoted summary, IN SCOPE / OUT OF SCOPE
   columns, RISK AREAS chips, plus low-confidence / missing-context / stale
   badges. Empty state (404 — nothing classified yet) offers a "Classify
   intent" CTA; the sync POST's isPending drives the loading state. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Icon, SectionLabel, Skeleton } from "@devdigest/ui";
import type { IntentDetail } from "@devdigest/shared";
import { useClassifyIntent, usePrIntent } from "@/lib/hooks/intent";
import { SCOPE_BULLET_ICON_SIZE, SKELETON_HEIGHT } from "./constants";
import { s } from "./styles";

export function IntentCard({
  prId,
  headSha,
}: {
  prId: string | null;
  headSha: string | null | undefined;
}) {
  const t = useTranslations("brief");
  const { data, isLoading } = usePrIntent(prId);
  const classify = useClassifyIntent(prId);

  if (isLoading) {
    return (
      <section>
        <SectionLabel icon="Target">{t("block.intent")}</SectionLabel>
        <Skeleton height={SKELETON_HEIGHT} />
      </section>
    );
  }

  // 404 (nothing classified yet) lands here too — queries stay 4xx-silent.
  if (!data) {
    return (
      <section>
        <SectionLabel icon="Target">{t("block.intent")}</SectionLabel>
        <div style={s.empty}>
          <p style={s.emptyText}>{t("intent.empty")}</p>
          <p style={s.emptyHint}>{t("intent.emptyHint")}</p>
          <Button
            kind="primary"
            size="sm"
            icon="Sparkles"
            loading={classify.isPending}
            onClick={() => classify.mutate()}
          >
            {classify.isPending ? t("intent.classifying") : t("intent.classifyCta")}
          </Button>
        </div>
      </section>
    );
  }

  const stale = data.stale || (headSha != null && data.head_sha !== headSha);
  const unavailableRefs = data.sources
    .filter((src) => src.status === "unavailable")
    .map((src) => src.ref);

  return (
    <section>
      <SectionLabel icon="Target" right={<IntentBadges intent={data} stale={stale} unavailableRefs={unavailableRefs} />}>
        {t("block.intent")}
      </SectionLabel>

      <div style={s.card}>
        <blockquote style={s.summary}>“{data.intent}”</blockquote>

        <div style={s.columns}>
          <ScopeColumn title={t("intent.inScope")} items={data.in_scope} dimmed={false} />
          <ScopeColumn title={t("intent.outOfScope")} items={data.out_of_scope} dimmed />
        </div>

        {data.risk_areas.length > 0 && (
          <div>
            <div style={s.columnTitle}>{t("intent.riskAreas")}</div>
            <div style={s.riskRow}>
              {data.risk_areas.map((risk) => (
                <Badge key={risk} icon="AlertTriangle" color="var(--warn)" bg="var(--bg-hover)">
                  {risk}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {stale && (
          <div style={s.badgeRow}>
            <Button
              kind="secondary"
              size="sm"
              icon="RefreshCw"
              loading={classify.isPending}
              onClick={() => classify.mutate()}
            >
              {classify.isPending ? t("intent.classifying") : t("intent.reclassify")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Header badges: low-confidence, missing-context (unavailable refs), stale. */
function IntentBadges({
  intent,
  stale,
  unavailableRefs,
}: {
  intent: IntentDetail;
  stale: boolean;
  unavailableRefs: string[];
}) {
  const t = useTranslations("brief");
  return (
    <div style={s.badgeRow}>
      {intent.confidence === "low" && (
        <Badge icon="AlertTriangle" color="var(--warn)">
          {t("intent.lowConfidence")}
        </Badge>
      )}
      {unavailableRefs.length > 0 && (
        <Badge
          icon="EyeOff"
          color="var(--text-muted)"
          style={s.missingContextBadge}
        >
          {t("intent.missingContext", { refs: unavailableRefs.join(", ") })}
        </Badge>
      )}
      {stale && (
        <Badge icon="Clock" color="var(--warn)">
          {t("intent.stale")}
        </Badge>
      )}
    </div>
  );
}

/** One scope column: check bullets (in scope) or dimmed x bullets (out of scope). */
function ScopeColumn({
  title,
  items,
  dimmed,
}: {
  title: string;
  items: string[];
  dimmed: boolean;
}) {
  const BulletIcon = dimmed ? Icon.X : Icon.Check;
  return (
    <div>
      <div style={s.columnTitle}>{title}</div>
      <ul style={s.scopeList}>
        {items.map((item) => (
          <li key={item} style={s.scopeItem(dimmed)}>
            <BulletIcon size={SCOPE_BULLET_ICON_SIZE} style={s.scopeIcon(dimmed)} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default IntentCard;
