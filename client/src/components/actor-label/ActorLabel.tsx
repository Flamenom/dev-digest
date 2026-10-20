/* ActorLabel — "Run by A" / "Run by Local user" / "—" (AC-45–AC-48).
   Text only: the name goes through React's text escaping (never HTML), and is
   truncated with CSS; the full label is kept in `title`. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { ActorRef } from "@devdigest/shared";
import { actorKind } from "./helpers";
import { DEFAULT_LABEL_MAX_WIDTH, type ActorVerb } from "./constants";
import { s } from "./styles";

export interface ActorLabelProps {
  actor: ActorRef | undefined;
  /** Prefix verb ("run" → "Run by {name}"). Omit to render the bare name. */
  verb?: ActorVerb;
  maxWidth?: number | string;
  style?: React.CSSProperties;
}

export function ActorLabel({ actor, verb, maxWidth = DEFAULT_LABEL_MAX_WIDTH, style }: ActorLabelProps) {
  const t = useTranslations("auth");
  let text: string;
  // Narrow on `actor` itself (not on the derived kind) so no `!` is needed.
  if (actor == null) {
    text = t("actor.none");
  } else {
    const name = actorKind(actor) === "system" ? t("actor.localUser") : actor.name;
    text = verb ? t(`actor.verbs.${verb}`, { name }) : name;
  }

  return (
    <span title={text} style={{ ...s.label(maxWidth), ...style }}>
      {text}
    </span>
  );
}

export default ActorLabel;
