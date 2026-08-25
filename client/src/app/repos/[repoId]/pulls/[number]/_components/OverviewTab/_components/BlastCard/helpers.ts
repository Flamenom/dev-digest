/* helpers.ts — pure derivations for the BlastCard (no React). */
import type { BlastResponse, BlastSymbolImpact, ChangedSymbol } from "@devdigest/shared";

/** Last path segment — compact node/row labels (full path goes in title). */
export function fileBase(path: string): string {
  return path.split("/").pop() ?? path;
}

/** `name()` for callables, bare `name` otherwise. */
export function symbolLabel(sym: ChangedSymbol): string {
  return sym.kind === "function" || sym.kind === "method" ? `${sym.name}()` : sym.name;
}

export interface SymbolPartition {
  /** Symbols with callers, most-called first — the rows worth reading. */
  active: BlastSymbolImpact[];
  /** Zero-caller symbols: no callers ⇒ no attributed endpoints/crons either,
      so they carry no impact info — collapsed into one summary row. */
  silent: BlastSymbolImpact[];
}

export function partitionSymbols(symbols: BlastSymbolImpact[]): SymbolPartition {
  return {
    active: symbols
      .filter((sym) => sym.callers.length > 0)
      .sort((a, b) => b.callers.length - a.callers.length),
    silent: symbols.filter((sym) => sym.callers.length === 0),
  };
}

/** Truncate a label with an ellipsis (SVG has no text-overflow). */
export function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export interface GraphImpact {
  label: string;
  kind: "endpoint" | "cron";
}

/**
 * Layered graph data for the SVG view: three node columns
 * (changed symbols → caller files → endpoints/crons) + index-pair edges.
 * Depth-1 only: depth-2 (reverse-import) endpoints have no symbol→file chain
 * to draw, so they stay in the tree's "indirect" row and the counts.
 */
export interface GraphData {
  symbols: string[];
  files: string[];
  impacts: GraphImpact[];
  /** symbol index → file index */
  edgesSF: Array<[number, number]>;
  /** file index → impact index */
  edgesFI: Array<[number, number]>;
}

export function buildGraph(data: BlastResponse): GraphData {
  // Zero-caller symbols would be edge-less floating nodes — draw active only.
  const impactful = partitionSymbols(data.symbols).active;
  const symbols = impactful.map((s) => s.symbol.name);

  const fileIdx = new Map<string, number>();
  const files: string[] = [];
  const indexFile = (file: string): number => {
    let i = fileIdx.get(file);
    if (i === undefined) {
      i = files.length;
      files.push(file);
      fileIdx.set(file, i);
    }
    return i;
  };

  const impactIdx = new Map<string, number>();
  const impacts: GraphImpact[] = [];
  const indexImpact = (label: string, kind: GraphImpact["kind"]): number => {
    const key = `${kind}|${label}`;
    let i = impactIdx.get(key);
    if (i === undefined) {
      i = impacts.length;
      impacts.push({ label, kind });
      impactIdx.set(key, i);
    }
    return i;
  };

  const edgesSF: Array<[number, number]> = [];
  const edgesFI: Array<[number, number]> = [];
  const seenSF = new Set<string>();
  const seenFI = new Set<string>();
  const addSF = (s: number, f: number) => {
    const key = `${s}|${f}`;
    if (seenSF.has(key)) return;
    seenSF.add(key);
    edgesSF.push([s, f]);
  };
  const addFI = (f: number, i: number) => {
    const key = `${f}|${i}`;
    if (seenFI.has(key)) return;
    seenFI.add(key);
    edgesFI.push([f, i]);
  };

  impactful.forEach((impact, si) => {
    const callerFiles = [...new Set(impact.callers.map((c) => c.file))];
    for (const file of callerFiles) addSF(si, indexFile(file));
    // Crons are attributed per symbol (union over its caller files) — connect
    // the cron node to each of the symbol's caller files.
    for (const cron of impact.crons_affected) {
      const ci = indexImpact(cron, "cron");
      for (const file of callerFiles) addFI(fileIdx.get(file)!, ci);
    }
  });

  // Depth-1 endpoints carry their exact file — precise file → endpoint edges.
  for (const ref of data.endpoints) {
    if (ref.depth !== 1) continue;
    const fi = fileIdx.get(ref.file);
    if (fi === undefined) continue; // endpoint on a non-caller file — tree only
    addFI(fi, indexImpact(ref.endpoint, "endpoint"));
  }

  return { symbols, files, impacts, edgesSF, edgesFI };
}
