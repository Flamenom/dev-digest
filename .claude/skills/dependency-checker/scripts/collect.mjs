#!/usr/bin/env node
// Collects raw dependency facts for all DevDigest packages: declared deps
// (by type), installed size on disk, installed version, and (best-effort)
// registry staleness via `pnpm outdated`. Emits one JSON blob on stdout.
//
// This script only gathers FACTS. It does not decide what's "heavy",
// "notable", or "worth deduping" — that judgment belongs to whoever reads
// the JSON (see SKILL.md), because it depends on context this script can't see.
//
// Usage: node collect.mjs [repoRoot] [--skip-outdated]

import { readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, extname } from "node:path";

const args = process.argv.slice(2);
const skipOutdated = args.includes("--skip-outdated");
const rootArg = args.find((a) => !a.startsWith("--"));
const ROOT = rootArg ? resolve(rootArg) : process.cwd();

// The 5 standalone packages this repo actually has (see root CLAUDE.md —
// this is NOT an npm/pnpm workspace, so each gets its own node_modules and lockfile).
const PACKAGE_DIRS = ["server", "client", "reviewer-core", "e2e", "mcp"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function duHuman(path) {
  try {
    return execFileSync("du", ["-sh", path], { encoding: "utf8" }).split("\t")[0].trim();
  } catch {
    return null;
  }
}

function duBytes(path) {
  try {
    const kb = execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0].trim();
    return parseInt(kb, 10) * 1024;
  } catch {
    return null;
  }
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".git", "clones"]);

function collectSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), out);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Best-effort "is this prod dep actually imported anywhere in this package's
// own source?" check — walks the package dir once (outside node_modules) and
// tests each file's text against an import/require of the dep name. A dep
// declared in package.json but never matched here is flagged as a candidate
// for removal; it's still just a text-pattern match (misses dynamic strings
// built at runtime), so treat a hit as strong evidence, not proof.
function isImportedInSource(depName, sourceFiles) {
  const escaped = escapeRegExp(depName);
  // A block comment (e.g. `/* @vite-ignore */`) commonly sits between `import(`
  // and the string literal — tolerate zero or more of those, not just whitespace.
  const gap = "(?:\\s|/\\*[^*]*\\*/)*";
  const pattern = new RegExp(
    `(\\bfrom${gap}['"]${escaped}(['"/])` + // import x from "dep"
      `|\\bimport${gap}['"]${escaped}(['"/])` + // bare side-effect import "dep/subpath"
      `|\\brequire\\(${gap}['"]${escaped}(['"/])` + // require("dep")
      `|\\bimport\\(${gap}['"]${escaped}(['"/]))`, // dynamic import("dep")
  );
  for (const file of sourceFiles) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) return true;
  }
  return false;
}

function collectPackage(dirName) {
  const pkgDir = join(ROOT, dirName);
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  const pkgJson = readJson(pkgJsonPath);
  const nodeModules = join(pkgDir, "node_modules");
  const nodeModulesInstalled = existsSync(nodeModules);

  const FIELDS = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
  ];

  // Collected once per package and reused for every prod dep's usage check —
  // walking the source tree per-dependency would be O(deps × files) for no reason.
  // collectSourceFiles already skips node_modules (and dist/build/...) during the walk.
  const sourceFiles = collectSourceFiles(pkgDir);

  const deps = [];
  for (const [field, type] of FIELDS) {
    const map = pkgJson[field] || {};
    for (const [name, versionRange] of Object.entries(map)) {
      const entryPath = join(nodeModules, ...name.split("/"));
      let installed = false;
      let installedVersion = null;
      let sizeBytes = null;
      let sizeHuman = null;

      if (nodeModulesInstalled && existsSync(entryPath)) {
        installed = true;
        try {
          // pnpm's node_modules/<name> is a symlink into .pnpm/<name>@ver/...;
          // realpath it first so `du` measures the actual package contents,
          // not the ~0-byte symlink.
          const real = realpathSync(entryPath);
          installedVersion = readJson(join(real, "package.json")).version ?? null;
          sizeBytes = duBytes(real);
          sizeHuman = duHuman(real);
        } catch {
          // best-effort; leave nulls if the dep dir is malformed
        }
      }

      // Usage check only applies to prod deps — dev tooling (typescript, vitest,
      // eslint, ...) is invoked via config/CLI, not imported, so "not found in an
      // import statement" would be a false positive there.
      const usedInSource = type === "prod" ? isImportedInSource(name, sourceFiles) : null;

      deps.push({ name, type, versionRange, installed, installedVersion, sizeBytes, sizeHuman, usedInSource });
    }
  }

  const totalNodeModulesSize = nodeModulesInstalled
    ? { bytes: duBytes(nodeModules), human: duHuman(nodeModules) }
    : null;

  // Per-dep sizes above measure only each top-level package's OWN files
  // (pnpm's content-addressable store keeps a dep's transitive deps as
  // separate, shared entries) — so the sum of listed deps will legitimately
  // fall well short of totalNodeModulesSize. That gap is transitive-dependency
  // weight pulled in by one or more of the top-level deps, not measurement
  // error; report it explicitly so nobody mistakes "explicit deps don't add
  // up" for a bug.
  const explicitDepsSizeBytes = deps.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);
  const transitiveGapBytes =
    totalNodeModulesSize?.bytes != null ? Math.max(0, totalNodeModulesSize.bytes - explicitDepsSizeBytes) : null;

  let outdated = null;
  if (!skipOutdated) {
    try {
      const out = execFileSync("pnpm", ["outdated", "--format", "json"], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 30000,
      });
      outdated = JSON.parse(out || "{}");
    } catch (err) {
      // pnpm outdated exits non-zero WHEN outdated deps exist — that's not
      // a failure, the JSON is still on stdout.
      if (err.stdout) {
        try {
          outdated = JSON.parse(err.stdout);
        } catch {
          outdated = { __error: "pnpm outdated printed unparseable output" };
        }
      } else {
        outdated = { __error: "pnpm outdated failed (offline, no registry access, or pnpm not on PATH)" };
      }
    }
  }

  return {
    name: pkgJson.name,
    dir: dirName,
    nodeModulesInstalled,
    totalNodeModulesSize,
    explicitDepsSize: { bytes: explicitDepsSizeBytes, human: formatBytes(explicitDepsSizeBytes) },
    transitiveGapSize:
      transitiveGapBytes != null ? { bytes: transitiveGapBytes, human: formatBytes(transitiveGapBytes) } : null,
    deps,
    outdated,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

const packages = PACKAGE_DIRS.map(collectPackage).filter(Boolean);

// Cross-package duplicate detection: same dep name declared in >1 of the
// 5 packages. Flagged because these packages are NOT an npm workspace —
// each resolves its own copy from its own independent lockfile, so the
// same lib can silently drift to different versions across packages.
const byName = new Map();
for (const pkg of packages) {
  for (const dep of pkg.deps) {
    if (!byName.has(dep.name)) byName.set(dep.name, []);
    byName.get(dep.name).push({
      package: pkg.dir,
      type: dep.type,
      versionRange: dep.versionRange,
      installedVersion: dep.installedVersion,
    });
  }
}

const duplicates = [];
for (const [name, occurrences] of byName.entries()) {
  const packagesInvolved = new Set(occurrences.map((o) => o.package));
  if (packagesInvolved.size > 1) {
    const versions = new Set(occurrences.map((o) => o.installedVersion ?? o.versionRange));
    duplicates.push({ name, occurrences, versionDrift: versions.size > 1 });
  }
}
duplicates.sort((a, b) => b.occurrences.length - a.occurrences.length);

process.stdout.write(JSON.stringify({ root: ROOT, packages, duplicates }, null, 2));
