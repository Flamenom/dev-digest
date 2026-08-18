import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import {
  parseSkillImport,
  parseFrontmatter,
  buildMarkdownPreview,
  locateSkillMd,
  suggestSkillType,
} from '../src/modules/skills/import.js';
import {
  MD_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  ZIP_MAX_BYTES,
} from '../src/modules/skills/constants.js';
import { ValidationError } from '../src/platform/errors.js';

/**
 * Hermetic tests for the parse-only import (spec §3.3/§3.6): frontmatter parse
 * + fallbacks, zip SKILL.md located at root / in a single subdir / missing,
 * the decoy install.sh only NAMED in `skipped` (its bytes provably never
 * inflated), and the size-limit rejections (checked before inflating).
 */

const FIXTURES = path.resolve(__dirname, 'fixtures/skill-import');

function mdBytes(content: string): Uint8Array {
  return strToU8(content);
}

function makeZip(entries: Record<string, string>): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 6 }]> = {};
  for (const [name, content] of Object.entries(entries)) {
    files[name] = [strToU8(content), { level: 6 }];
  }
  return zipSync(files, { level: 6 });
}

/**
 * Corrupt the compressed DATA of one entry in a zip, leaving all headers (and
 * therefore the name/size directory) intact. Inflating the entry afterwards
 * throws — so a parser that survives this zip provably never read the entry.
 */
function corruptEntryData(zip: Uint8Array, entryName: string): Uint8Array {
  const out = new Uint8Array(zip);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let i = 0;
  while (i < out.length - 4) {
    if (dv.getUint32(i, true) !== 0x04034b50) {
      i++;
      continue;
    }
    const csize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(out.subarray(i + 30, i + 30 + nameLen));
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === entryName) {
      out.fill(0xff, dataStart, dataStart + csize);
      return out;
    }
    i = dataStart + csize;
  }
  throw new Error(`entry ${entryName} not found in zip`);
}

const SKILL_MD = `---
name: my-skill
description: "Do the thing carefully."
---

# My Skill

The first paragraph explains the rule.

- a bullet
`;

describe('frontmatter parsing', () => {
  it('parses name + description and strips the block from the body', () => {
    const fm = parseFrontmatter(SKILL_MD);
    expect(fm.hadFrontmatter).toBe(true);
    expect(fm.name).toBe('my-skill');
    expect(fm.description).toBe('Do the thing carefully.'); // quotes stripped
    expect(fm.body.startsWith('# My Skill')).toBe(true);
    expect(fm.body).not.toContain('---');
  });

  it('treats content without a leading --- as all-body', () => {
    const fm = parseFrontmatter('# Heading\n\ntext');
    expect(fm.hadFrontmatter).toBe(false);
    expect(fm.name).toBeUndefined();
    expect(fm.body).toBe('# Heading\n\ntext');
  });

  it('ignores an unterminated frontmatter block', () => {
    const fm = parseFrontmatter('---\nname: x\nno closing fence');
    expect(fm.hadFrontmatter).toBe(false);
    expect(fm.name).toBeUndefined();
  });

  it('only reads name/description lines (plain strings, quotes stripped)', () => {
    const fm = parseFrontmatter(
      "---\nname: 'quoted'\nallowed-tools: Bash(rm -rf /)\ndescription: plain\n---\nbody",
    );
    expect(fm.name).toBe('quoted');
    expect(fm.description).toBe('plain');
  });
});

describe('markdown preview fallbacks', () => {
  it('falls back to the first # heading for the name', () => {
    const p = buildMarkdownPreview('some-file.md', '# From Heading\n\nFirst paragraph here.');
    expect(p.name).toBe('From Heading');
    expect(p.description).toBe('First paragraph here.');
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to the filename when there is no heading', () => {
    const p = buildMarkdownPreview('nested/dir/my-imported-skill.md', 'Just prose, no heading.');
    expect(p.name).toBe('my-imported-skill');
  });

  it('truncates a long first paragraph to ~200 chars', () => {
    const long = 'word '.repeat(100).trim();
    const p = buildMarkdownPreview('x.md', `# T\n\n${long}`);
    expect(p.description.length).toBeLessThanOrEqual(200);
    expect(p.description.endsWith('…')).toBe(true);
  });
});

describe('suggested_type heuristic', () => {
  it("suggests 'security' for secret/injection/SSRF-ish content", () => {
    expect(suggestSkillType('Never commit a secret key; watch for SQL injection.')).toBe(
      'security',
    );
    expect(suggestSkillType('Block SSRF via URL allowlists')).toBe('security');
  });

  it("suggests 'convention' for house-rule content", () => {
    expect(suggestSkillType('Our naming convention for repository files')).toBe('convention');
  });

  it("defaults to 'custom'", () => {
    expect(suggestSkillType('Check pagination boundaries and retries.')).toBe('custom');
  });
});

describe('zip imports', () => {
  it('finds SKILL.md at the archive root', () => {
    const zip = makeZip({ 'SKILL.md': SKILL_MD, 'install.sh': 'echo pwned' });
    const p = parseSkillImport('my-skill.zip', zip);
    expect(p.name).toBe('my-skill');
    expect(p.body).toContain('# My Skill');
    expect(p.skipped).toEqual(['install.sh']);
  });

  it('finds SKILL.md inside a single top-level directory', () => {
    const zip = makeZip({
      'my-skill/SKILL.md': SKILL_MD,
      'my-skill/scripts/run.sh': 'echo hi',
    });
    const p = parseSkillImport('my-skill.zip', zip);
    expect(p.name).toBe('my-skill');
    expect(p.skipped).toEqual(['my-skill/scripts/run.sh']);
  });

  it('rejects an archive without SKILL.md', () => {
    const zip = makeZip({ 'README.md': '# nope', 'a/b.txt': 'x' });
    expect(() => parseSkillImport('bad.zip', zip)).toThrow(ValidationError);
    expect(() => parseSkillImport('bad.zip', zip)).toThrow(/SKILL\.md/);
  });

  it('rejects SKILL.md hidden in one of MULTIPLE top-level directories', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD, 'b/other.txt': 'x' });
    expect(() => parseSkillImport('bad.zip', zip)).toThrow(ValidationError);
  });

  it('NEVER reads non-SKILL.md entries — a corrupted decoy does not break the parse', () => {
    const zip = makeZip({ 'SKILL.md': SKILL_MD, 'install.sh': '#!/bin/sh\necho pwned\n' });
    const corrupted = corruptEntryData(zip, 'install.sh');

    // Sanity: actually inflating the decoy now throws — its data is ruined.
    expect(() => unzipSync(corrupted)).toThrow();

    // Our parser survives (it only names the decoy, never inflates it) …
    const p = parseSkillImport('my-skill.zip', corrupted);
    expect(p.skipped).toEqual(['install.sh']);
    // … and no decoy content leaks anywhere in the preview.
    expect(JSON.stringify(p)).not.toContain('pwned');
  });

  it('locateSkillMd is case-sensitive and root-first', () => {
    expect(locateSkillMd(['SKILL.md', 'dir/SKILL.md'])).toBe('SKILL.md');
    expect(locateSkillMd(['skill.md'])).toBeUndefined();
    expect(locateSkillMd(['only/SKILL.md'])).toBe('only/SKILL.md');
  });
});

describe('size limits (enforced before inflating)', () => {
  it('rejects a .md over 256 KB', () => {
    const big = mdBytes('x'.repeat(MD_MAX_BYTES + 1));
    expect(() => parseSkillImport('big.md', big)).toThrow(/too large/);
  });

  it('rejects a .zip over 2 MB compressed without opening it', () => {
    // Not even a valid zip — the length check fires first.
    const big = new Uint8Array(ZIP_MAX_BYTES + 1);
    expect(() => parseSkillImport('big.zip', big)).toThrow(/too large/);
  });

  it('rejects a SKILL.md entry whose DECLARED size exceeds 256 KB (zip-bomb guard)', () => {
    // 300 KB of one repeated char compresses to well under 2 KB — the parser
    // must reject on the declared uncompressed size, not the compressed one.
    const bomb = makeZip({ 'SKILL.md': 'a'.repeat(SKILL_MD_MAX_BYTES + 1024) });
    expect(bomb.length).toBeLessThan(ZIP_MAX_BYTES);
    expect(() => parseSkillImport('bomb.zip', bomb)).toThrow(/SKILL\.md too large/);
  });

  it('rejects unsupported file types', () => {
    expect(() => parseSkillImport('evil.exe', mdBytes('MZ...'))).toThrow(/Unsupported/);
  });
});

describe('committed fixtures', () => {
  it('flaky-test-patterns.md parses with frontmatter name + description', () => {
    const data = readFileSync(path.join(FIXTURES, 'flaky-test-patterns.md'));
    const p = parseSkillImport('flaky-test-patterns.md', data);
    expect(p.name).toBe('flaky-test-patterns');
    expect(p.description).toContain('time-, order-, or randomness-dependent');
    expect(p.body.startsWith('# Flaky test patterns')).toBe(true);
    expect(p.skipped).toEqual([]);
  });

  it('flaky-test-patterns.zip yields SKILL.md and skips the install.sh decoy', () => {
    const data = readFileSync(path.join(FIXTURES, 'flaky-test-patterns.zip'));
    const p = parseSkillImport('flaky-test-patterns.zip', data);
    expect(p.name).toBe('flaky-test-patterns');
    expect(p.body).toContain('Real-clock sleeps');
    expect(p.skipped).toEqual(['install.sh']);
    expect(JSON.stringify(p)).not.toContain('pwned');
  });
});
