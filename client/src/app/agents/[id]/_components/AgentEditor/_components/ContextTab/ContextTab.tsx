"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Checkbox,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  IconBtn,
  Markdown,
  SelectInput,
  Skeleton,
  TextInput,
} from "@devdigest/ui";
import type { Agent, DiscoveredDocument } from "@devdigest/shared";
import { useRepos } from "@/lib/hooks/core";
import { useDocument, useProjectContext, useSetAgentDocs } from "@/lib/hooks/projectContext";
import { rootDirOf } from "@/lib/root-dir";
import {
  attachedTokensOf,
  fileNameOf,
  folderOf,
  matchesFilter,
  moveBy,
  moveTo,
  orderRows,
  togglePath,
} from "./helpers";
import { BUCKET_BADGE, DRAG_HANDLE_GLYPH, NEUTRAL_BADGE } from "./constants";
import { s } from "./styles";

/** Context tab — attach/detach and order the repo project documents (specs/docs/
    insights) injected into this agent's runs. Mirrors the SkillsTab membership
    model: every change PUTs the FULL ordered path set to
    PUT /agents/:id/attached-docs. Attach state is keyed by path, never by
    visible row, so filtering can never change it (AC-12). */
export function ContextTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  const reposQ = useRepos();
  const repos = reposQ.data ?? [];
  // R-7 default: discover against the workspace's first repo unless the user picks another.
  const [selectedRepoId, setSelectedRepoId] = React.useState<string | null>(null);
  const repoId = selectedRepoId ?? repos[0]?.id ?? null;
  const ctxQ = useProjectContext(repoId);
  const setDocs = useSetAgentDocs(agent.id);

  const [filter, setFilter] = React.useState("");
  // Drag state: path being dragged + the live preview of the attached-path order.
  const [dragPath, setDragPath] = React.useState<string | null>(null);
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);

  const documents = ctxQ.data?.documents ?? [];
  const cloneAvailable = ctxQ.data?.summary.clone_available ?? true;
  const attachedPaths = agent.attached_doc_paths ?? [];
  const displayPaths = dragOrder ?? attachedPaths;
  const rows = orderRows(documents, displayPaths);
  const filtering = filter.trim().length > 0;
  const visible = filtering ? rows.filter((d) => matchesFilter(d, filter)) : rows;
  const discoveredAttached = attachedPaths.filter((p) => documents.some((d) => d.path === p));
  const attachedTokens = attachedTokensOf(documents, attachedPaths);

  const persist = (paths: string[]) => {
    if (setDocs.isPending) return;
    setDocs.mutate({ paths });
  };
  const toggle = (path: string, on: boolean) => persist(togglePath(attachedPaths, path, on));
  const move = (path: string, delta: -1 | 1) => persist(moveBy(attachedPaths, path, delta));

  const startDrag = (e: React.DragEvent, path: string) => {
    // dataTransfer is absent in jsdom — guard every access.
    e.dataTransfer?.setData?.("text/plain", path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragPath(path);
    setDragOrder(attachedPaths);
  };

  const dragOverRow = (e: React.DragEvent, overPath: string) => {
    if (!dragPath || !displayPaths.includes(overPath)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOrder((cur) => moveTo(cur ?? attachedPaths, dragPath, overPath));
  };

  // Commit on dragend (fires after drop and on cancel): persist the order the user sees.
  const endDrag = () => {
    if (dragPath && dragOrder && dragOrder.join("\n") !== attachedPaths.join("\n")) {
      setDocs.mutate({ paths: dragOrder });
    }
    setDragPath(null);
    setDragOrder(null);
  };

  if (reposQ.isError || ctxQ.isError) {
    return (
      <ErrorState
        title={t("context.title")}
        body={t("context.loadError")}
        onRetry={() => {
          void reposQ.refetch();
          void ctxQ.refetch();
        }}
      />
    );
  }

  if (reposQ.isLoading || (repoId != null && ctxQ.isLoading)) {
    return (
      <div style={s.wrap}>
        <div style={s.skeletons}>
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <EmptyState
        icon="FileText"
        title={t("context.noReposTitle")}
        body={t("context.noReposBody")}
      />
    );
  }

  const previewDoc = previewPath ? documents.find((d) => d.path === previewPath) : undefined;

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("context.title")}</h2>
        <span aria-live="polite">
          <Chip icon="FileText">
            {t("context.attachedCount", {
              attached: discoveredAttached.length,
              total: documents.length,
            })}
          </Chip>
        </span>
        <div style={s.filterBox}>
          <TextInput
            value={filter}
            onChange={setFilter}
            placeholder={t("context.filterPlaceholder")}
          />
        </div>
      </div>
      {repos.length > 1 && (
        <div style={s.repoRow}>
          <span style={s.repoLabel}>{t("context.repoLabel")}</span>
          <div style={s.repoSelect}>
            <SelectInput
              value={repoId ?? ""}
              onChange={setSelectedRepoId}
              options={repos.map((r) => ({ value: r.id, label: r.full_name }))}
            />
          </div>
        </div>
      )}
      <p style={s.caption} aria-live="polite">
        <span style={s.estimate}>{t("context.tokensEstimate", { tokens: attachedTokens })}</span>
        {" · "}
        {t("context.untrustedNote")}
      </p>
      <p style={s.caption}>{t("context.orderHint")}</p>
      {!cloneAvailable ? (
        <EmptyState
          icon="FileText"
          title={t("context.cloneUnavailableTitle")}
          body={t("context.cloneUnavailableBody")}
        />
      ) : documents.length === 0 ? (
        <EmptyState
          icon="FileText"
          title={t("context.emptyTitle")}
          body={t("context.emptyBody")}
        />
      ) : visible.length === 0 ? (
        <div style={s.noMatches}>{t("context.noMatches")}</div>
      ) : (
        <ul style={s.list}>
          {visible.map((doc) => {
            const attached = displayPaths.includes(doc.path);
            const at = attachedPaths.indexOf(doc.path);
            return (
              <DocRow
                key={doc.path}
                doc={doc}
                attached={attached}
                draggable={attached && !filtering && !setDocs.isPending}
                dragging={dragPath === doc.path}
                canMoveUp={at > 0}
                canMoveDown={at >= 0 && at < attachedPaths.length - 1}
                onToggle={(on) => toggle(doc.path, on)}
                onMoveUp={() => move(doc.path, -1)}
                onMoveDown={() => move(doc.path, 1)}
                onPreview={() => setPreviewPath(doc.path)}
                onDragStart={(e) => startDrag(e, doc.path)}
                onDragOver={(e) => dragOverRow(e, doc.path)}
                onDragEnd={endDrag}
              />
            );
          })}
        </ul>
      )}
      {previewDoc && repoId && (
        <PreviewDrawer
          repoId={repoId}
          doc={previewDoc}
          attached={attachedPaths.includes(previewDoc.path)}
          onToggle={(on) => toggle(previewDoc.path, on)}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}

/** Root-dir badge — labelled with the FIRST path segment (bucket only as a
    root-level fallback); colour + text label (never colour alone, WCAG 2.1 AA). */
function RootDirBadge({ doc }: { doc: DiscoveredDocument }) {
  const label = rootDirOf(doc.path) ?? doc.bucket ?? "/";
  const palette = BUCKET_BADGE[label] ?? NEUTRAL_BADGE;
  return (
    <Badge mono color={palette.color} bg={palette.bg}>
      {label}
    </Badge>
  );
}

/** One document row: drag handle (attached only), move up/down (keyboard
    alternative to drag), attach checkbox, filename + folder, bucket badge, Preview. */
function DocRow({
  doc,
  attached,
  draggable,
  dragging,
  canMoveUp,
  canMoveDown,
  onToggle,
  onMoveUp,
  onMoveDown,
  onPreview,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  doc: DiscoveredDocument;
  attached: boolean;
  draggable: boolean;
  dragging: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: (on: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPreview: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const t = useTranslations("agents");
  const name = fileNameOf(doc.path);
  const folder = folderOf(doc.path);
  return (
    <li
      style={{ ...s.row, ...(dragging ? s.rowDragging : {}) }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
    >
      {draggable ? (
        <span style={s.handle} aria-hidden>
          {DRAG_HANDLE_GLYPH}
        </span>
      ) : (
        <span style={s.handlePlaceholder} aria-hidden />
      )}
      <Checkbox checked={attached} onChange={onToggle} />
      <span style={s.nameBox}>
        <span className="mono" style={s.name}>
          {name}
        </span>
        {folder && (
          <span className="mono" style={s.folder}>
            {folder}
          </span>
        )}
      </span>
      <RootDirBadge doc={doc} />
      {/* Per-row weight: the file's estimated token count. */}
      <Badge mono>{t("context.tokens", { tokens: doc.estimated_tokens })}</Badge>
      <span style={s.rowActions}>
        <span style={s.moveSlot}>
          {attached && canMoveUp && (
            <IconBtn icon="ArrowUp" size={24} label={t("context.moveUp")} onClick={onMoveUp} />
          )}
        </span>
        <span style={s.moveSlot}>
          {attached && canMoveDown && (
            <IconBtn icon="ArrowDown" size={24} label={t("context.moveDown")} onClick={onMoveDown} />
          )}
        </span>
        <IconBtn icon="Eye" size={24} label={t("context.preview")} onClick={onPreview} />
      </span>
    </li>
  );
}

/** Preview drawer — rendered markdown + 4 metadata items: bucket badge, token
    count, "Used by N agents", attach toggle (AC-13). */
function PreviewDrawer({
  repoId,
  doc,
  attached,
  onToggle,
  onClose,
}: {
  repoId: string;
  doc: DiscoveredDocument;
  attached: boolean;
  onToggle: (on: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations("agents");
  const docQ = useDocument(repoId, doc.path);
  return (
    <Drawer title={fileNameOf(doc.path)} subtitle={doc.path} onClose={onClose}>
      <div style={s.metaRow}>
        <RootDirBadge doc={doc} />
        <Badge mono>{t("context.tokens", { tokens: doc.estimated_tokens })}</Badge>
        <span style={s.metaText}>
          {t("context.usedByAgents", { count: doc.used_by_agents ?? 0 })}
        </span>
        <Checkbox checked={attached} onChange={onToggle} label={t("context.attachToggle")} />
      </div>
      {docQ.isLoading ? (
        <Skeleton height={160} />
      ) : docQ.isError ? (
        <div style={s.noMatches}>{t("context.previewError")}</div>
      ) : (
        <Markdown>{docQ.data?.text}</Markdown>
      )}
    </Drawer>
  );
}
