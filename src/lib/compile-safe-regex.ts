import safeRegex from "safe-regex2";

const MAX_PATTERN_LENGTH = 200;

/**
 * Compiles a CMS-authored validation pattern after safe-regex2 screening.
 * Isolated so static analyzers can document the deliberate non-literal RegExp.
 */
export function compileSafeRegexPattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN_LENGTH || !safeRegex(pattern)) {
    return null;
  }
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
