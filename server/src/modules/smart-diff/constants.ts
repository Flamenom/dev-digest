/**
 * Smart Diff classifier patterns + thresholds (spec 05 §4). Deterministic,
 * path + pattern only — no RepoIntel signal, no LLM, no I/O. Matching is on
 * the repo-relative path with case-sensitive basename/segment checks.
 *
 * Precedence: boilerplate → wiring → core (default). Misclassification errs
 * toward core ("review closely") — the fail-safe direction.
 */

// ---- Boilerplate (generated / mechanical — skim) ---------------------------

/** Exact lockfile basenames. */
export const BOILERPLATE_BASENAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

/** Any directory segment in this set marks the file boilerplate. */
export const BOILERPLATE_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'node_modules',
  '__snapshots__',
  '__generated__',
  '.next',
  'vendor',
]);

/** Generated-artifact and binary-asset suffixes. */
export const BOILERPLATE_SUFFIXES = [
  '.snap',
  '.min.js',
  '.min.css',
  '.map',
  // binary assets
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
] as const;

/** Basename containing this marker is generated code. */
export const GENERATED_BASENAME_MARKER = '.generated.';

/** Consecutive segment pair marking drizzle migration snapshots. */
export const DRIZZLE_META_SEGMENT_PAIR = ['migrations', 'meta'] as const;

// ---- Wiring (hooks the core into the app) ----------------------------------

/** Exact wiring basenames. */
export const WIRING_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'Dockerfile',
  'Makefile',
]);

/** `tsconfig.json`, `tsconfig.base.json`, `tsconfig.build.json`, … */
export const TSCONFIG_RE = /^tsconfig(\..+)?\.json$/;

/** Tool-config basename suffixes (`vitest.config.ts`, `next.config.mjs`, …). */
export const WIRING_CONFIG_SUFFIXES = ['.config.js', '.config.ts', '.config.cjs', '.config.mjs'] as const;

/** CI lives here regardless of extension. */
export const WIRING_PATH_PREFIX = '.github/';

/** YAML anywhere = CI / compose / pipeline config. */
export const WIRING_YAML_SUFFIXES = ['.yml', '.yaml'] as const;

/**
 * Barrel files. Deliberately NOT `index.tsx`/`index.jsx` — those may be real
 * components and stay core (user-confirmed decision, spec §14.4).
 */
export const WIRING_BARREL_BASENAMES: ReadonlySet<string> = new Set(['index.ts', 'index.js']);

/** `.sql` under a segment with this name is a migration (reviewable, mechanical). */
export const MIGRATIONS_SEGMENT = 'migrations';

// ---- Thresholds (user-confirmed 2026-08-21, spec §14.2) --------------------

/** `split_suggestion.too_big` when Σ(additions+deletions) exceeds this. */
export const TOO_BIG_TOTAL_LINES = 1000;
/** Max lines expanded per finding into `finding_lines`. */
export const FINDING_LINE_SPAN_CAP = 10;
/** Fewer role/segment splits than this → `proposed_splits: []`. */
export const MIN_PROPOSED_SPLITS = 2;

/** Groups are ALWAYS emitted, all three roles, in this fixed order. */
export const GROUP_ORDER = ['core', 'wiring', 'boilerplate'] as const;
