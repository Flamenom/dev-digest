/** Code files sent to the extraction call (step 2). */
export const SAMPLE_TOP_N = 12;
/** Ranked files offered to the selection call (step 1). */
export const SELECTION_POOL_N = 40;
export const MAX_CONFIG_FILES = 8;
/** Per-file content cap sent to the model. */
export const MAX_FILE_CHARS = 8_000;
/** Extraction output cap. */
export const MAX_CANDIDATES = 15;

/**
 * Config files probed directly from the clone: repo-intel's ranked sampling
 * excludes configs by design (`isJunkPath`), yet they are the densest source
 * of explicit conventions.
 */
export const CONFIG_FILE_CANDIDATES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  'prettier.config.cjs',
  'biome.json',
  '.editorconfig',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
] as const;
