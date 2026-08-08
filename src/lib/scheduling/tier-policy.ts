/**
 * Visit-cadence "Tier Policy".
 *
 * Herself Health stewards patients on a per-risk-tier visit cadence: higher
 * acuity patients are seen more often. The authoritative tier lives on the
 * Salesforce Account as `Risk_Tier__c`; whether the patient is currently
 * behind that cadence lives on `Off_Cadence_Actual__c` (boolean).
 *
 * This module maps the tier string to a target number of visits per year so
 * the standalone scheduler can ENCOURAGE patients to book on tier ("your
 * care plan recommends ... visits a year"). It is a nudge, never a
 * hard gate — patients can always book.
 *
 * The visits/year numbers are a configurable product constant. Update
 * TIER_VISITS_PER_YEAR (and the test) if Care Delivery revises the policy.
 *
 * Tier string variants observed in Salesforce / Athena (Risk_Tier__c):
 *   "Highly Complex", "OM - High Risk/Rising", "High Risk", "High Risk/Rising",
 *   "Rising", "Low", "Low Risk", "No Tier", null/empty.
 */

export type RiskTier =
  | "highly_complex"
  | "high_rising"
  | "rising"
  | "low"
  | "no_tier";

/** Resolved visit-cadence policy for a Salesforce risk tier. */
export interface TierPolicy {
  tier: RiskTier;
  /** Human label for the resolved tier. */
  label: string;
  /** Target visits per year for the tier (the on-tier cadence). */
  visitsPerYear: number;
  /** Patient-facing cadence phrase, e.g. "about every 3 months". */
  cadenceLabel: string;
}

/**
 * Target visits per year per tier. PROPOSED defaults (confirm with Care
 * Delivery). Higher acuity → more frequent visits.
 */
export const TIER_VISITS_PER_YEAR: Record<RiskTier, number> = {
  highly_complex: 6,
  high_rising: 4,
  rising: 3,
  low: 2,
  no_tier: 1,
};

const TIER_LABEL: Record<RiskTier, string> = {
  highly_complex: "Highly Complex",
  high_rising: "High Risk / Rising",
  rising: "Rising",
  low: "Low",
  no_tier: "Standard",
};

/** Turn a target visits/year into a friendly cadence phrase. */
function cadencePhrase(visitsPerYear: number): string {
  if (visitsPerYear >= 12) return "about once a month";
  if (visitsPerYear <= 0) return "as needed";
  const months = Math.round(12 / visitsPerYear);
  if (months <= 1) return "about once a month";
  if (months >= 12) return "about once a year";
  return `about every ${months} months`;
}

/**
 * Normalize a raw Salesforce `Risk_Tier__c` value into a RiskTier bucket.
 * Unknown / empty values map to "no_tier".
 */
export function normalizeRiskTier(raw: string | null | undefined): RiskTier {
  const v = (raw ?? "").toLowerCase().trim();
  if (!v) return "no_tier";
  if (v.includes("highly complex") || v.includes("complex")) {
    return "highly_complex";
  }
  // "OM - High Risk/Rising", "High Risk", "High Risk/Rising" all → high_rising.
  if (v.includes("high")) return "high_rising";
  if (v.includes("rising")) return "rising";
  if (v.includes("low")) return "low";
  return "no_tier";
}

/** Resolve the full TierPolicy for a raw Salesforce tier value. */
export function getTierPolicy(rawRiskTier: string | null | undefined): TierPolicy {
  const tier = normalizeRiskTier(rawRiskTier);
  const visitsPerYear = TIER_VISITS_PER_YEAR[tier];
  return {
    tier,
    label: TIER_LABEL[tier],
    visitsPerYear,
    cadenceLabel: cadencePhrase(visitsPerYear),
  };
}

/**
 * Patient-facing encouragement copy. When the patient is flagged off
 * cadence we lead with a gentle "you're due" nudge; otherwise we reinforce
 * the recommended rhythm.
 */
export function getTierCadenceMessage(
  policy: TierPolicy,
  offCadence: boolean | null | undefined
): string {
  const base = `Your care plan recommends ${policy.visitsPerYear} ${
    policy.visitsPerYear === 1 ? "visit" : "visits"
  } a year — ${policy.cadenceLabel}.`;
  if (offCadence) {
    return `It looks like you're due for a visit. ${base} Scheduling now helps you stay on track.`;
  }
  return `${base} Booking your next visit keeps you on track.`;
}
