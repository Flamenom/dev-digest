/* ContextTab — attach repo project documents (specs/docs/insights) to a SKILL
   (AC-15..AC-17). Rows mirror the agent Context tab: order handle (drag) with a
   keyboard alternative (move up/down buttons), attach toggle, filename, path,
   root-dir badge (colour + text label), token count, Preview. Persists the skill's ORDERED
   list of paths only (never text) via useSetSkillDocs. Discovery is per-repo:
   selector when the workspace has >1 repo, defaulting to the first (R-7). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Card,
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
import type { DiscoveredDocument, Skill } from "@devdigest/shared";
import { useRepos } from "@/lib/hooks/core";
import { useDocument, useProjectContext, useSetSkillDocs } from "@/lib/hooks/projectContext";
import { rootDirOf } from "@/lib/root-dir";
import { BUCKET_COLORS, DRAG_HANDLE_GLYPH, NEUTRAL_COLORS } from "./constants";
import { fileName, matchesQuery, moveTo, movePath, orderDocs, serializePreview, togglePath } from "./helpers";
import { s } from "./styles";

export function ContextTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const reposQ = useRepos();
  const setDocs = useSetSkillDocs(skill.id);

  // Only the EXPLICIT selection is state; the effective repo derives from it.
  const [selectedRepoId, setSelectedRepoId] = React.useState<string | null>(null);
  const repos = reposQ.data ?? [];
  const repoId = selectedRepoId ?? repos[0]?.id ?? null;
  const ctxQ = useProjectContext(repoId);

  const [filter, setFilter] = React.useState("");
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);
  // Drag state: path being dragged + the live preview of the attached order.
  const [dragPath, setDragPath] = React.useState<string | null>(null);
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);

  const documents = ctxQ.data?.documents ?? [];
  const attached = skill.attached_doc_paths;
  const displayPaths = dragOrder ?? attached;
  const rows = orderDocs(documents, displayPaths);
  const filtering = filter.trim().length > 0;
  const visible = filtering ? rows.filter((d) => matchesQuery(d, filter)) : rows;
  const previewDoc = documents.find((d) => d.path === previewPath) ?? null;

  const persist = (paths: string[]) => {
    if (!setDocs.isPending) setDocs.mutate({ paths });
  };
  const toggle = (path: string, on: boolean) => persist(togglePath(attached, path, on));
  const move = (path: string, delta: number) => {
    const next = movePath(attached, path, delta);
    if (next !== attached) persist(next);
  };

  const startDrag = (e: React.DragEvent, path: string) => {
    // dataTransfer is absent in jsdom — guard every access.
    e.dataTransfer?.setData?.("text/plain", path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragPath(path);
    setDragOrder(attached);
  };
  const dragOverRow = (e: React.DragEvent, overPath: string) => {
    if (!dragPath || !displayPaths.includes(overPath)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOrder((cur) => moveTo(cur ?? attached, dragPath, overPath));
  };
  const endDrag = () => {
    if (dragPath && dragOrder && dragOrder.join("\n") !== attached.join("\n")) {
      persist(dragOrder);
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

  if (reposQ.isLoading || (repoId && ctxQ.isLoading)) {
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

  if (!repoId) {
    return (
      <EmptyState icon="Folder" title={t("context.noReposTitle")} body={t("context.noReposBody")} />
    );
  }

  const cloneAvailable = ctxQ.data?.summary.clone_available ?? true;

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("context.title")}</h2>
        <Chip icon="FileText">
          <span aria-live="polite">{t("context.attachedCount", { count: attached.length })}</span>
        </Chip>
        {repos.length > 1 && (
          <label style={s.repoPicker}>
            {t("context.repoLabel")}
            <SelectInput
              value={repoId}
              onChange={setSelectedRepoId}
              options={repos.map((r) => ({ value: r.id, label: r.full_name }))}
            />
          </label>
        )}
        <div style={s.filterBox}>
          <TextInput
            value={filter}
            onChange={setFilter}
            placeholder={t("context.searchPlaceholder")}
          />
        </div>
      </div>
      <p style={s.caption}>
        {t("context.inheritanceNote")} {t("context.orderHint")}
      </p>

      {!cloneAvailable ? (
        <EmptyState
          icon="Folder"
          title={t("context.cloneUnavailableTitle")}
          body={t("context.cloneUnavailableBody")}
        />
      ) : documents.length === 0 ? (
        <EmptyState icon="FileText" title={t("context.emptyTitle")} body={t("context.emptyBody")} />
      ) : visible.length === 0 ? (
        <div style={s.noMatches}>{t("context.noMatches")}</div>
      ) : (
        <ul style={s.list}>
          {visible.map((doc) => {
            const isAttached = displayPaths.includes(doc.path);
            const name = fileName(doc.path);
            return (
              <DocumentRow
                key={doc.path}
                doc={doc}
                name={name}
                attached={isAttached}
                draggable={isAttached && !filtering && !setDocs.isPending}
                dragging={dragPath === doc.path}
                tokensLabel={t("context.tokens", { count: doc.estimated_tokens })}
                moveUpLabel={t("context.moveUp", { name })}
                moveDownLabel={t("context.moveDown", { name })}
                previewLabel={t("context.previewLabel", { name })}
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

      <section style={s.serializeSection} aria-label={t("context.serializesTitle")}>
        <h3 style={s.serializeTitle}>{t("context.serializesTitle")}</h3>
        <p style={s.serializeHint}>{t("context.serializesHint")}</p>
        <Card style={s.serializeCard}>
          {attached.length === 0 ? (
            <p style={s.serializeHint}>{t("context.serializesEmpty")}</p>
          ) : (
            <pre className="mono" style={s.serializePre}>
              {serializePreview(attached)}
            </pre>
          )}
        </Card>
      </section>

      {previewDoc && (
        <PreviewDrawer
          repoId={repoId}
          doc={previewDoc}
          tokensLabel={t("context.tokens", { count: previewDoc.estimated_tokens })}
          loadError={t("context.drawerLoadError")}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}

/** One document row: order handle + keyboard move buttons (attached only),
    attach toggle (filename is its label), path, root-dir badge, per-row token
    count, Preview. */
function DocumentRow({
  doc,
  name,
  attached,
  draggable,
  dragging,
  tokensLabel,
  moveUpLabel,
  moveDownLabel,
  previewLabel,
  onToggle,
  onMoveUp,
  onMoveDown,
  onPreview,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  doc: DiscoveredDocument;
  name: string;
  attached: boolean;
  draggable: boolean;
  dragging: boolean;
  tokensLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  previewLabel: string;
  onToggle: (on: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPreview: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  // Badge = root directory of the path; bucket only as a root-level fallback.
  const rootDir = rootDirOf(doc.path) ?? doc.bucket ?? "/";
  const tone = BUCKET_COLORS[rootDir] ?? NEUTRAL_COLORS;
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
      {attached && (
        <span style={s.orderBtns}>
          <IconBtn icon="ArrowUp" size={24} label={moveUpLabel} onClick={onMoveUp} />
          <IconBtn icon="ArrowDown" size={24} label={moveDownLabel} onClick={onMoveDown} />
        </span>
      )}
      <Checkbox
        checked={attached}
        onChange={onToggle}
        label={
          <span className="mono" style={s.name}>
            {name}
          </span>
        }
      />
      <span className="mono" style={s.path}>
        {doc.path}
      </span>
      <span style={s.rowEnd}>
        <Badge color={tone.color} bg={tone.bg} dot>
          {rootDir}
        </Badge>
        {/* Per-row weight: the file's estimated token count. */}
        <Badge mono>{tokensLabel}</Badge>
        <IconBtn icon="Eye" label={previewLabel} onClick={onPreview} />
      </span>
    </li>
  );
}

/** Preview drawer — the document's markdown rendered, with root-dir + token badges. */
function PreviewDrawer({
  repoId,
  doc,
  tokensLabel,
  loadError,
  onClose,
}: {
  repoId: string;
  doc: DiscoveredDocument;
  tokensLabel: string;
  loadError: string;
  onClose: () => void;
}) {
  const docQ = useDocument(repoId, doc.path);
  const rootDir = rootDirOf(doc.path) ?? doc.bucket ?? "/";
  const tone = BUCKET_COLORS[rootDir] ?? NEUTRAL_COLORS;
  return (
    <Drawer title={fileName(doc.path)} subtitle={doc.path} onClose={onClose}>
      <div style={s.drawerMeta}>
        <Badge color={tone.color} bg={tone.bg} dot>
          {rootDir}
        </Badge>
        <Badge mono>{tokensLabel}</Badge>
      </div>
      {docQ.isError ? (
        <ErrorState title={loadError} onRetry={() => void docQ.refetch()} />
      ) : docQ.isLoading || !docQ.data ? (
        <div style={s.skeletons}>
          <Skeleton height={16} />
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      ) : (
        <div style={s.drawerBody}>
          <Markdown>{docQ.data.text}</Markdown>
        </div>
      )}
    </Drawer>
  );
}
