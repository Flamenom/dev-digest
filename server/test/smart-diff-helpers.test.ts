/**
 * Smart Diff pure builders (`modules/smart-diff/helpers.ts`) — the deterministic
 * path classifier and the SmartDiff assembler (spec 05 §4). Pure functions over
 * plain shapes (pulls-status.test.ts style): no DB, no fastify, no Docker.
 * Latest-per-agent review selection is the SERVICE's job and is covered in
 * smart-diff.it.test.ts; here `findings` is already the filtered union.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSmartDiff,
  classifyPath,
  type SmartDiffFindingInput,
} from '../src/modules/smart-diff/helpers.js';
import {
  FINDING_LINE_SPAN_CAP,
  TOO_BIG_TOTAL_LINES,
} from '../src/modules/smart-diff/constants.js';

const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });

const finding = (
  over: Partial<SmartDiffFindingInput> & { file: string },
): SmartDiffFindingInput => ({
  startLine: 1,
  endLine: 1,
  severity: 'WARNING',
  dismissedAt: null,
  ...over,
});

describe('classifyPath', () => {
  it('classifies every boilerplate pattern class', () => {
    const boilerplate = [
      // exact lockfile basenames, at root and nested
      'pnpm-lock.yaml',
      'server/package-lock.json',
      'yarn.lock',
      'bun.lockb',
      'Cargo.lock',
      'poetry.lock',
      'Pipfile.lock',
      'composer.lock',
      'Gemfile.lock',
      'go.sum',
      // generated/output directory segments anywhere in the path
      'dist/app.js',
      'client/build/main.ts',
      'out/report.txt',
      'coverage/lcov.info',
      'node_modules/pkg/index.js',
      'src/__snapshots__/Comp.test.tsx.snap',
      'api/__generated__/types.ts',
      '.next/static/chunk.js',
      'server/vendor/lib.ts',
      // generated-artifact + binary-asset suffixes
      'src/Comp.test.tsx.snap',
      'lib/app.min.js',
      'styles/site.min.css',
      'bundle.js.map',
      'assets/logo.png',
      'img/a.jpg',
      'img/b.jpeg',
      'img/c.gif',
      'favicon.ico',
      'icons/close.svg',
      'fonts/inter.woff',
      'fonts/inter.woff2',
      // `.generated.` marker + drizzle migrations/meta snapshots
      'src/api.generated.ts',
      'server/src/db/migrations/meta/0001_snapshot.json',
    ];
    for (const p of boilerplate) expect(classifyPath(p), p).toBe('boilerplate');
  });

  it('classifies every wiring pattern class', () => {
    const wiring = [
      // dotfiles
      '.gitignore',
      'server/.env.local',
      '.eslintrc.js',
      '.prettierrc',
      // tsconfig*
      'tsconfig.json',
      'server/tsconfig.build.json',
      // *.config.* tool configs
      'vitest.config.ts',
      'client/next.config.mjs',
      'tailwind.config.js',
      'some.config.cjs',
      // exact basenames
      'package.json',
      'client/package.json',
      'pnpm-workspace.yaml',
      'Dockerfile',
      'ops/Makefile',
      // .github/ prefix (any extension) + YAML anywhere
      '.github/workflows/ci.yml',
      '.github/CODEOWNERS',
      'docker-compose.yml',
      'k8s/deploy.yaml',
      // barrels — index.ts / index.js only
      'src/index.ts',
      'lib/index.js',
      // .sql under a migrations segment
      'server/src/db/migrations/0001_init.sql',
    ];
    for (const p of wiring) expect(classifyPath(p), p).toBe('wiring');
  });

  it('defaults to core: index.tsx/jsx, tests, business logic, .sql outside migrations', () => {
    const core = [
      'src/index.tsx', // may be a real component — user-confirmed core (spec §14.4)
      'components/index.jsx',
      'server/src/modules/foo/service.ts',
      'client/src/app/page.tsx',
      'src/helpers.test.ts',
      'README.md',
      'src/queries/report.sql', // .sql but no migrations segment
    ];
    for (const p of core) expect(classifyPath(p), p).toBe('core');
  });

  it('boilerplate wins over wiring on overlap', () => {
    // ends .yaml (wiring rule) but is a lockfile
    expect(classifyPath('pnpm-lock.yaml')).toBe('boilerplate');
    // barrel + exact wiring basename, but under a generated segment
    expect(classifyPath('dist/index.ts')).toBe('boilerplate');
    expect(classifyPath('dist/package.json')).toBe('boilerplate');
    // .github/ prefix (wiring) but a binary-asset suffix
    expect(classifyPath('.github/assets/logo.png')).toBe('boilerplate');
  });
});

describe('buildSmartDiff', () => {
  it('always emits all three groups in fixed order; empty findings input still works', () => {
    const d = buildSmartDiff([file('src/service.ts', 10, 2)], []);

    expect(d.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(d.groups[0]!.files).toEqual([
      {
        path: 'src/service.ts',
        pseudocode_summary: null,
        additions: 10,
        deletions: 2,
        finding_lines: [],
      },
    ]);
    expect(d.groups[1]!.files).toEqual([]);
    expect(d.groups[2]!.files).toEqual([]);
    expect(d.split_suggestion).toEqual({ too_big: false, total_lines: 12, proposed_splits: [] });
  });

  it('sorts within a group by findings desc, then changed lines desc, then path asc', () => {
    const files = [
      file('src/z.ts', 100, 0), // 0 findings, most lines
      file('src/b.ts', 5, 0), // 1 finding, ties with a.ts on lines
      file('src/a.ts', 5, 0), // 1 finding, ties with b.ts on lines
      file('src/c.ts', 50, 0), // 1 finding, more lines than a/b
      file('src/big.ts', 2, 1), // 2 findings, fewest lines — still first
    ];
    const findings = [
      finding({ file: 'src/big.ts', startLine: 1, endLine: 1 }),
      finding({ file: 'src/big.ts', startLine: 2, endLine: 2 }),
      finding({ file: 'src/a.ts', startLine: 1, endLine: 1 }),
      finding({ file: 'src/b.ts', startLine: 1, endLine: 1 }),
      finding({ file: 'src/c.ts', startLine: 1, endLine: 1 }),
      // dismissed — must not count toward src/z.ts's sort key
      finding({ file: 'src/z.ts', startLine: 1, endLine: 1, dismissedAt: new Date() }),
    ];

    const d = buildSmartDiff(files, findings);
    expect(d.groups[0]!.files.map((f) => f.path)).toEqual([
      'src/big.ts', // findings desc
      'src/c.ts', // 1 finding, changed-lines desc
      'src/a.ts', // 1 finding, tie on lines → path asc
      'src/b.ts',
      'src/z.ts', // 0 active findings despite most lines
    ]);
  });

  it('builds finding_lines: span cap, dedupe+ascending, dismissed/unanchored/malformed rules', () => {
    const findings = [
      // span capped at FINDING_LINE_SPAN_CAP lines
      finding({ file: 'src/a.ts', startLine: 5, endLine: 40 }),
      // overlapping + out-of-order inputs → deduped, ascending
      finding({ file: 'src/a.ts', startLine: 8, endLine: 10 }),
      finding({ file: 'src/a.ts', startLine: 3, endLine: null }), // null endLine → anchor only
      // dismissed → excluded entirely
      finding({ file: 'src/a.ts', startLine: 100, endLine: 105, dismissedAt: new Date() }),
      // no startLine → skipped (nothing to anchor)
      finding({ file: 'src/a.ts', startLine: null, endLine: 7 }),
      // malformed endLine < startLine → still yields the anchor line
      finding({ file: 'src/a.ts', startLine: 50, endLine: 2 }),
      // other file — must not leak
      finding({ file: 'src/b.ts', startLine: 1, endLine: 1 }),
    ];

    const d = buildSmartDiff([file('src/a.ts')], findings);
    const capped = Array.from({ length: FINDING_LINE_SPAN_CAP }, (_, i) => 5 + i); // 5..14
    expect(d.groups[0]!.files[0]!.finding_lines).toEqual([3, ...capped, 50]);
  });

  it('split_suggestion: too_big only STRICTLY above the threshold', () => {
    const atLimit = buildSmartDiff([file('src/a.ts', TOO_BIG_TOTAL_LINES, 0)], []);
    expect(atLimit.split_suggestion).toEqual({
      too_big: false,
      total_lines: TOO_BIG_TOTAL_LINES,
      proposed_splits: [],
    });

    const over = buildSmartDiff([file('src/a.ts', TOO_BIG_TOTAL_LINES, 1)], []);
    expect(over.split_suggestion.too_big).toBe(true);
    expect(over.split_suggestion.total_lines).toBe(TOO_BIG_TOTAL_LINES + 1);
  });

  it('proposes role-based splits when at least two roles are non-empty', () => {
    const d = buildSmartDiff(
      [file('src/service.ts', 900, 0), file('package.json', 200, 0)],
      [],
    );
    expect(d.split_suggestion.too_big).toBe(true);
    expect(d.split_suggestion.total_lines).toBe(1100);
    expect(d.split_suggestion.proposed_splits).toEqual([
      { name: 'core', files: ['src/service.ts'] },
      { name: 'wiring', files: ['package.json'] },
    ]);
  });

  it('falls back to first-path-segment splits when fewer than two roles are non-empty', () => {
    const d = buildSmartDiff(
      [file('server/service.ts', 600, 0), file('client/page.tsx', 500, 0)],
      [],
    );
    expect(d.split_suggestion.too_big).toBe(true);
    // all files are core (1 non-empty role) → group by first segment, name asc
    expect(d.split_suggestion.proposed_splits).toEqual([
      { name: 'client', files: ['client/page.tsx'] },
      { name: 'server', files: ['server/service.ts'] },
    ]);
  });

  it('yields empty proposed_splits when even the segment fallback has fewer than two groups', () => {
    const d = buildSmartDiff(
      [file('src/a.ts', 600, 0), file('src/b.ts', 500, 0)], // one role, one segment
      [],
    );
    expect(d.split_suggestion.too_big).toBe(true);
    expect(d.split_suggestion.proposed_splits).toEqual([]);
  });
});
