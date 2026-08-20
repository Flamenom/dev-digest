import { strFromU8, unzipSync } from 'fflate';
import type { SkillImportPreview, SkillType } from '@devdigest/shared';
import { ValidationError } from '../../platform/errors.js';
import {
  DESCRIPTION_MAX_CHARS,
  MD_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  ZIP_MAX_BYTES,
} from './constants.js';

/**
 * L02 — parse-only skill import (POST /skills/import). Pure functions: an
 * uploaded `.md` file or Claude-style `.zip` (SKILL.md inside) in, a
 * `SkillImportPreview` out. NOTHING is persisted here.
 *
 * Security properties (spec §3.3):
 *  - Zip entries other than SKILL.md are only NAMED in `skipped` — their
 *    contents are never inflated, read, or stored (fflate's `filter` skips
 *    non-matching entries without touching their compressed data).
 *  - Size limits are enforced BEFORE inflating: raw upload caps (.md ≤ 256 KB,
 *    .zip ≤ 2 MB compressed) and the SKILL.md entry's DECLARED uncompressed
 *    size from the zip directory (≤ 256 KB) — the zip-bomb guard.
 */

// ---- type heuristic ---------------------------------------------------------

const SECURITY_KEYWORDS = [
  'secret',
  'credential',
  'sql injection',
  'prompt injection',
  'command injection',
  'ssrf',
  'xss',
  'csrf',
  'vulnerab',
  'exploit',
  'sanitiz',
  'auth bypass',
  'security',
];

const CONVENTION_KEYWORDS = [
  'convention',
  'house rule',
  'naming',
  'style guide',
  'code style',
  'team standard',
  'formatting',
];

/** 'security' for secret/injection/SSRF-ish content, 'convention' for house rules, else 'custom'. */
export function suggestSkillType(text: string): SkillType {
  const haystack = text.toLowerCase();
  if (SECURITY_KEYWORDS.some((k) => haystack.includes(k))) return 'security';
  if (CONVENTION_KEYWORDS.some((k) => haystack.includes(k))) return 'convention';
  return 'custom';
}

// ---- frontmatter ------------------------------------------------------------

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  /** Markdown with the frontmatter block stripped. */
  body: string;
  hadFrontmatter: boolean;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Minimal line-based frontmatter parser: an optional leading `---` block; only
 * `name:` and `description:` are read (plain string values, surrounding quotes
 * stripped). Anything else in the block is ignored. Not a YAML parser on purpose
 * — imported content is untrusted and we only need two flat strings.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { body: content, hadFrontmatter: false };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return { body: content, hadFrontmatter: false };

  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines.slice(1, end)) {
    const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = stripQuotes(m[2]!.trim());
    if (m[1] === 'name' && name === undefined) name = value;
    if (m[1] === 'description' && description === undefined) description = value;
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return {
    ...(name !== undefined && name !== '' ? { name } : {}),
    ...(description !== undefined && description !== '' ? { description } : {}),
    body,
    hadFrontmatter: true,
  };
}

// ---- fallbacks ---------------------------------------------------------------

/** First `# heading` text, or undefined. */
function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body);
  return m?.[1]?.trim();
}

/** Filename without directories or extension — the last-resort name. */
function baseName(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  return base.replace(/\.(md|zip)$/i, '');
}

/** First paragraph (skipping headings / code fences), truncated to ~200 chars. */
function firstParagraph(body: string): { text: string; truncated: boolean } {
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    const oneLine = trimmed.replace(/\s+/g, ' ');
    if (oneLine.length <= DESCRIPTION_MAX_CHARS) return { text: oneLine, truncated: false };
    return { text: `${oneLine.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`, truncated: true };
  }
  return { text: '', truncated: false };
}

// ---- markdown → preview -------------------------------------------------------

/** Build a preview from raw SKILL/skill markdown; `fallbackName` covers the no-heading case. */
export function buildMarkdownPreview(fallbackName: string, content: string): SkillImportPreview {
  const warnings: string[] = [];
  const fm = parseFrontmatter(content);

  let name = fm.name;
  if (name === undefined) {
    const heading = firstHeading(fm.body);
    name = heading ?? baseName(fallbackName);
    warnings.push(
      heading !== undefined
        ? 'No frontmatter "name" — derived from the first heading.'
        : 'No frontmatter "name" or heading — derived from the filename.',
    );
  }

  let description = fm.description;
  if (description === undefined) {
    const para = firstParagraph(fm.body);
    description = para.text;
    warnings.push(
      para.truncated
        ? 'No frontmatter "description" — derived from the first paragraph (truncated).'
        : 'No frontmatter "description" — derived from the first paragraph.',
    );
  }

  return {
    name,
    description,
    body: fm.body,
    suggested_type: suggestSkillType(`${name}\n${description}\n${fm.body}`),
    skipped: [],
    warnings,
  };
}

// ---- zip ----------------------------------------------------------------------

/**
 * Find the SKILL.md path: at the root, or inside a SINGLE top-level directory
 * (the Claude skill layout `my-skill/SKILL.md`). Returns undefined if absent.
 */
export function locateSkillMd(fileNames: string[]): string | undefined {
  if (fileNames.includes('SKILL.md')) return 'SKILL.md';
  const topLevelDirs = new Set(
    fileNames.filter((n) => n.includes('/')).map((n) => n.split('/')[0]!),
  );
  // Only unambiguous: exactly one top-level dir and every file lives under it.
  if (topLevelDirs.size !== 1 || fileNames.some((n) => !n.includes('/'))) return undefined;
  const [dir] = topLevelDirs;
  const candidate = `${dir}/SKILL.md`;
  return fileNames.includes(candidate) ? candidate : undefined;
}

/** Parse a Claude-style skill zip. Only SKILL.md is ever inflated. */
export function parseSkillZip(filename: string, data: Uint8Array): SkillImportPreview {
  if (data.length > ZIP_MAX_BYTES) {
    throw new ValidationError(
      `Zip archive too large: ${data.length} bytes (max ${ZIP_MAX_BYTES} compressed)`,
    );
  }

  // Pass 1 — enumerate entry names + DECLARED sizes only. The filter always
  // returns false, so fflate never inflates any entry's data here.
  const entries: { name: string; declaredSize: number }[] = [];
  try {
    unzipSync(data, {
      filter: (info) => {
        entries.push({ name: info.name, declaredSize: info.originalSize ?? 0 });
        return false;
      },
    });
  } catch (err) {
    throw new ValidationError(`Not a readable zip archive: ${(err as Error).message}`);
  }

  const files = entries.filter((e) => !e.name.endsWith('/'));
  const target = locateSkillMd(files.map((f) => f.name));
  if (!target) {
    throw new ValidationError(
      'No SKILL.md found at the archive root or inside a single top-level directory',
    );
  }

  // Zip-bomb guard: reject on the entry's declared uncompressed size BEFORE inflating.
  const skillEntry = files.find((f) => f.name === target)!;
  if (skillEntry.declaredSize > SKILL_MD_MAX_BYTES) {
    throw new ValidationError(
      `SKILL.md too large: ${skillEntry.declaredSize} bytes uncompressed (max ${SKILL_MD_MAX_BYTES})`,
    );
  }

  // Pass 2 — inflate ONLY the SKILL.md entry.
  const unzipped = unzipSync(data, { filter: (info) => info.name === target });
  const content = strFromU8(unzipped[target]!);

  // Everything else is only NAMED — refused, never extracted.
  const skipped = files.filter((f) => f.name !== target).map((f) => f.name);

  const preview = buildMarkdownPreview(filename, content);
  return {
    ...preview,
    skipped,
    warnings: [
      ...preview.warnings,
      ...(skipped.length > 0
        ? [`${skipped.length} archive entr${skipped.length === 1 ? 'y was' : 'ies were'} not processed (listed under "skipped").`]
        : []),
    ],
  };
}

// ---- entrypoint ----------------------------------------------------------------

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // "PK\x03\x04"

/** Dispatch an uploaded file (by filename / magic bytes) to the md or zip parser. */
export function parseSkillImport(filename: string, data: Uint8Array): SkillImportPreview {
  const lower = filename.toLowerCase();
  const looksZip =
    lower.endsWith('.zip') || ZIP_MAGIC.every((byte, i) => data[i] === byte);
  if (looksZip) return parseSkillZip(filename, data);

  if (lower.endsWith('.md')) {
    if (data.length > MD_MAX_BYTES) {
      throw new ValidationError(
        `Markdown file too large: ${data.length} bytes (max ${MD_MAX_BYTES})`,
      );
    }
    return buildMarkdownPreview(filename, strFromU8(data));
  }

  throw new ValidationError('Unsupported file type — upload a .md file or a .zip archive');
}
