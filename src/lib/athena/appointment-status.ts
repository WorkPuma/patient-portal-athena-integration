/**
 * Athena appointment status codes — single source of truth.
 *
 * Athena's API returns one-letter (or one-digit) codes from a closed set.
 * The patient portal previously embedded a `STATUS_MAP` literal in
 * `AppointmentList.tsx`, leaking raw codes whenever a new status appeared
 * (the fallback rendered the raw code, e.g. "3", to the patient).
 *
 * This module exposes:
 *   - `AthenaApptStatusCode`  – tagged-template for autocomplete safety.
 *   - `ATHENA_APPT_STATUS`    – the canonical code → label map.
 *   - `apptStatusLabel(code)` – resolver that *never* returns the raw code.
 *   - `apptStatusVariant(code)` – semantic style bucket for the UI badge.
 *
 * Codes documented at
 * https://docs.athenahealth.com/api/workflows/appointment-statuses
 */

export type AthenaApptStatusCode =
  | "f" // Future / Scheduled
  | "o" // Open (slot)
  | "x" // Cancelled
  | "2" // Checked In
  | "3" // Checked Out
  | "4" // Charge Entered (closed)
  | "p" // Confirmed
  | "n" // No-show
  | "h"; // On hold

/** Code → patient-facing label. */
export const ATHENA_APPT_STATUS: Record<AthenaApptStatusCode, string> = {
  f: "Scheduled",
  o: "Open",
  x: "Cancelled",
  "2": "Checked In",
  "3": "Checked Out",
  "4": "Visit Closed",
  p: "Confirmed",
  n: "No-show",
  h: "On Hold",
};

/** Semantic variant for the UI badge — kept narrow on purpose. */
export type AthenaApptStatusVariant =
  | "scheduled"
  | "checked-in"
  | "completed"
  | "cancelled"
  | "no-show"
  | "neutral";

const VARIANT_BY_CODE: Record<AthenaApptStatusCode, AthenaApptStatusVariant> = {
  f: "scheduled",
  p: "scheduled",
  o: "neutral",
  x: "cancelled",
  "2": "checked-in",
  "3": "completed",
  "4": "completed",
  n: "no-show",
  h: "neutral",
};

/**
 * Resolve a label for *any* code returned by Athena. Unknown codes fall
 * back to "Status update" — never the raw single-letter code.
 */
export function apptStatusLabel(code: string | null | undefined): string {
  if (!code) return "Status update";
  const lookup = ATHENA_APPT_STATUS[code as AthenaApptStatusCode];
  return lookup ?? "Status update";
}

/** Resolve the badge variant for the UI. Defaults to neutral. */
export function apptStatusVariant(
  code: string | null | undefined
): AthenaApptStatusVariant {
  if (!code) return "neutral";
  return VARIANT_BY_CODE[code as AthenaApptStatusCode] ?? "neutral";
}
