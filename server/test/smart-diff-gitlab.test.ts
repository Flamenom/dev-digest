/**
 * Smart Diff GitLab wiring rule (spec AC-34/AC-35): GitLab CI config is
 * classified as wiring exactly like GitHub's `.github/`. Asserted explicitly
 * so a future change to the dotfile/YAML rules can't silently regress it.
 */
import { describe, it, expect } from 'vitest';
import { classifyPath } from '../src/modules/smart-diff/helpers.js';
import {
  WIRING_BASENAMES,
  WIRING_PATH_PREFIX,
  WIRING_PATH_PREFIXES,
} from '../src/modules/smart-diff/constants.js';

describe('smart-diff GitLab wiring', () => {
  it('classifies GitLab CI config as wiring', () => {
    expect(classifyPath('.gitlab-ci.yml')).toBe('wiring');
    expect(classifyPath('.gitlab/issue_templates/bug.md')).toBe('wiring');
    expect(classifyPath('.gitlab/ci/build.ts')).toBe('wiring');
    // GitHub behaviour unchanged.
    expect(classifyPath('.github/workflows/ci.yml')).toBe('wiring');
    expect(classifyPath('.github/CODEOWNERS')).toBe('wiring');
  });

  it('does not treat gitlab-named source files as wiring', () => {
    expect(classifyPath('src/gitlab.ts')).not.toBe('wiring');
    expect(classifyPath('src/gitlab.ts')).toBe('core');
    expect(classifyPath('src/.gitlab-helpers/x.ts')).toBe('core');
  });

  it('declares the GitLab rule explicitly in constants', () => {
    expect(WIRING_BASENAMES.has('.gitlab-ci.yml')).toBe(true);
    expect(WIRING_PATH_PREFIXES).toContain('.gitlab/');
    expect(WIRING_PATH_PREFIXES).toContain(WIRING_PATH_PREFIX);
    expect(WIRING_PATH_PREFIX).toBe('.github/');
  });
});
