/**
 * Strict numeric coercion for schedule-link inputs.
 *
 * Athena ids (patient/appointment/department/provider/type) are positive
 * integers. `Number(...)` / `parseInt(...)` are too lenient for untrusted
 * token claims and request bodies: `parseInt("12abc")` -> 12, `Number("")`
 * -> 0, `Number("1.5")` -> 1.5. Those slip past `Number.isFinite` and get
 * forwarded to Athena as wrong ids or `"NaN"` query params. Validate the
 * full string is digits and the result is a safe positive integer.
 */

function safeTrim(value: unknown): string {
  try {
    return String(value).trim();
  } catch {
    return "";
  }
}

/** Parse a strictly-positive integer id. Returns null for empty, decimal,
 *  negative, non-numeric, or out-of-safe-range input. */
export function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = safeTrim(value);
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Required positive integer on an API body field (missing, empty, or malformed → error). */
export function parseRequiredPositiveInt(
  value: unknown,
  fieldName: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === null || value === undefined || safeTrim(value) === "") {
    return { ok: false, error: `${fieldName} is required` };
  }
  const parsed = toPositiveInt(value);
  if (parsed === null) {
    return { ok: false, error: `${fieldName} must be a positive integer` };
  }
  return { ok: true, value: parsed };
}

/** Optional positive integer: absent → undefined, malformed → null. */
export function parseOptionalPositiveInt(value: unknown): number | undefined | null {
  if (value === null || value === undefined || safeTrim(value) === "") {
    return undefined;
  }
  return toPositiveInt(value);
}
