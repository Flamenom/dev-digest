/* BlastGraph — self-contained layered SVG of the blast radius (no external
   graph libs): three node columns — changed symbols → caller files →
   endpoints/crons — connected by curved edges. Same data + click handlers as
   the Tree view (a caller-file node click jumps to that file in the diff). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { BlastResponse } from "@devdigest/shared";
import { buildGraph, fileBase, truncate } from "../../helpers";
import { GRAPH, s } from "./styles";

/** Vertical center of row `i` in a column of `count` nodes (total height H). */
function rowY(i: number, count: number, height: number): number {
  const usable = height - GRAPH.padY * 2;
  const step = count > 1 ? usable / (count - 1) : 0;
  return count > 1 ? GRAPH.padY + i * step : height / 2;
}

/** Cubic edge between the right edge of one node and the left edge of another. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function BlastGraph({
  data,
  onFileClick,
}: {
  data: BlastResponse;
  onFileClick?: (file: string) => void;
}) {
  const t = useTranslations("blast");
  const graph = React.useMemo(() => buildGraph(data), [data]);

  if (graph.edgesSF.length === 0) {
    return <div style={s.empty}>{t("graph.empty")}</div>;
  }

  const maxRows = Math.max(graph.symbols.length, graph.files.length, graph.impacts.length, 1);
  const height = GRAPH.padY * 2 + Math.max((maxRows - 1) * (GRAPH.nodeHeight + GRAPH.rowGap), GRAPH.nodeHeight);
  const colX = (col: number) => col * (GRAPH.colWidth + GRAPH.colGap) + 4;

  const symY = (i: number) => rowY(i, graph.symbols.length, height);
  const fileY = (i: number) => rowY(i, graph.files.length, height);
  const impY = (i: number) => rowY(i, graph.impacts.length, height);

  const columns: Array<{ label: string; x: number }> = [
    { label: t("columns.symbols"), x: colX(0) },
    { label: t("columns.callers"), x: colX(1) },
    { label: t("columns.impact"), x: colX(2) },
  ];

  return (
    <div style={s.svgWrap}>
      <svg
        role="img"
        aria-label={t("graph.ariaLabel")}
        viewBox={`0 0 ${GRAPH.width} ${height}`}
        width="100%"
        style={{ minWidth: 480, display: "block" }}
      >
        {columns.map((c) => (
          <text key={c.label} x={c.x} y={12} style={s.columnLabel}>
            {c.label}
          </text>
        ))}

        {graph.edgesSF.map(([si, fi]) => (
          <path
            key={`sf-${si}-${fi}`}
            d={edgePath(colX(0) + GRAPH.colWidth, symY(si), colX(1), fileY(fi))}
            style={s.edge}
          />
        ))}
        {graph.edgesFI.map(([fi, ii]) => (
          <path
            key={`fi-${fi}-${ii}`}
            d={edgePath(colX(1) + GRAPH.colWidth, fileY(fi), colX(2), impY(ii))}
            style={s.edge}
          />
        ))}

        {graph.symbols.map((name, i) => (
          <GraphNode key={`s-${name}`} x={colX(0)} y={symY(i)} label={`${truncate(name, GRAPH.labelMaxChars)}()`} full={name} kind="symbol" />
        ))}
        {graph.files.map((file, i) => (
          <GraphNode
            key={`f-${file}`}
            x={colX(1)}
            y={fileY(i)}
            label={truncate(fileBase(file), GRAPH.labelMaxChars)}
            full={file}
            kind="file"
            onClick={onFileClick ? () => onFileClick(file) : undefined}
          />
        ))}
        {graph.impacts.map((imp, i) => (
          <GraphNode
            key={`i-${imp.kind}-${imp.label}`}
            x={colX(2)}
            y={impY(i)}
            label={truncate(imp.label, GRAPH.labelMaxChars)}
            full={imp.label}
            kind={imp.kind}
          />
        ))}
      </svg>
    </div>
  );
}

/** One node: rounded rect + centered mono label (+ full text tooltip). */
function GraphNode({
  x,
  y,
  label,
  full,
  kind,
  onClick,
}: {
  x: number;
  y: number;
  label: string;
  full: string;
  kind: "symbol" | "file" | "endpoint" | "cron";
  onClick?: () => void;
}) {
  const clickable = onClick != null;
  return (
    <g
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick();
            }
          : undefined
      }
      style={clickable ? { cursor: "pointer" } : undefined}
    >
      <title>{full}</title>
      <rect
        x={x}
        y={y - GRAPH.nodeHeight / 2}
        width={GRAPH.colWidth}
        height={GRAPH.nodeHeight}
        rx={5}
        style={s.node(kind)}
      />
      <text className="mono" x={x + 8} y={y + 4} style={s.nodeText(clickable)}>
        {label}
      </text>
    </g>
  );
}

export default BlastGraph;
