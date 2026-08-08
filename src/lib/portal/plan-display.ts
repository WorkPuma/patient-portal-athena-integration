/**
 * Patient-facing plan view-model.
 *
 * The package resolver returns Athena `insurance_package_id`s, EMC codes,
 * EDI payer ids, and other internal identifiers that have no meaning to a
 * patient and are a HIPAA / privacy footgun if they leak to the DOM. This
 * module is the only sanctioned way to surface plan information in the UI.
 *
 * Build the view-model with `toPlanDisplay()` on the server (or in the API
 * client) and pass the resulting `PlanDisplay` into JSX. The UI imports
 * `PlanDisplay`, never the resolver result directly.
 *
 * See docs/portal/coverage-classification-sanity-check.md for how
 * `coverageCategory` is derived.
 */

import type { PackageResolverResult } from "@/lib/stedi/types";

/** Coverage category surfaced to the patient. */
export type CoverageCategory =
  | "commercial"
  | "medicare"
  | "medicare_advantage"
  | "medicare_supplement"
  | "medicaid"
  | "tricare"
  | "champva_va"
  | "federal_employee"
  | "unknown";

/** What we're willing to show the patient. No raw IDs, ever. */
export interface PlanDisplay {
  /** Carrier brand the patient picked (e.g. "UnitedHealthcare"). */
  carrierName: string;
  /**
   * Plan label suitable for display. Falls back to brand name when the 271
   * didn't return a planName (common for Humana, TRICARE, some BCBS).
   */
  planLabel: string;
  /**
   * Coverage category — drives downstream flow decisions (membership skip,
   * copy variants, government-plan badge).
   */
  coverageCategory: CoverageCategory;
  /**
   * True when the patient should skip the Membership step. Government
   * coverage (Medicare / Medicaid / TRICARE / VA / FEP / Medigap) is the
   * skip condition. See coverage-classification-sanity-check.md.
   */
  skipMembership: boolean;
  /**
   * True when the resolver had to lean on heuristics or the dominant-package
   * fallback. UI should require an explicit "Yes, that's my plan"
   * confirmation in this case (Theme H.1 plan-name confirmation card).
   */
  needsConfirmation: boolean;
  /**
   * Short, patient-friendly explanation of what we found. Never includes
   * resolver internals (no IDs, no EB04 codes, no `reason:` payload).
   */
  patientFriendlyReason: string;
}

/**
 * Build a `PlanDisplay` from a resolver result + the patient-picked brand
 * name. Internal identifiers are intentionally dropped on the floor.
 */
export function toPlanDisplay(args: {
  brandDisplayName: string;
  resolver: PackageResolverResult;
  /** From the 271 (`NormalizedEligibility.planName`). */
  planNameFrom271?: string | null;
  /** From the 271 (`NormalizedEligibility.coverageStatus`). */
  coverageStatus?: "active" | "inactive" | "unknown";
}): PlanDisplay {
  const { brandDisplayName, resolver, planNameFrom271 } = args;

  const planLabel =
    planNameFrom271?.trim() ||
    resolver.insurancePlanName?.trim() ||
    brandDisplayName;

  const coverageCategory = inferCoverageCategory({
    brandDisplayName,
    resolver,
    planLabel,
  });

  // Membership only applies to confirmed-active commercial coverage. Anything
  // else — government coverage, an unknown/inactive 271, an unresolved
  // resolver pick — should route the patient past Membership rather than
  // ask them to enroll in a plan we can't validate against.
  const coverageStatus = args.coverageStatus ?? "unknown";
  const isCommercialActive =
    coverageCategory === "commercial" && coverageStatus === "active";
  const skipMembership =
    !isCommercialActive ||
    resolver.confidence === "fallback" ||
    resolver.confidence === "unresolved";

  const needsConfirmation =
    resolver.lowConfidence ||
    resolver.confidence === "fallback" ||
    resolver.confidence === "unresolved";

  return {
    carrierName: brandDisplayName,
    planLabel,
    coverageCategory,
    skipMembership,
    needsConfirmation,
    patientFriendlyReason: patientFriendlyReason(resolver, coverageCategory),
  };
}

function inferCoverageCategory(args: {
  brandDisplayName: string;
  resolver: PackageResolverResult;
  planLabel: string;
}): CoverageCategory {
  const { brandDisplayName, resolver, planLabel } = args;
  const upper = `${brandDisplayName} ${planLabel} ${resolver.insurancePlanName ?? ""}`.toUpperCase();

  if (/\b(MEDIGAP|MED(ICARE)? SUPP(LEMENT)?(AL)?)\b/.test(upper))
    return "medicare_supplement";
  if (/\b(MEDICARE ADVANTAGE|MA[- ]?(PPO|HMO)|MAPD|LPPO|REPLACEMENT)\b/.test(upper))
    return "medicare_advantage";
  if (/\bAARP MEDICARE\b/.test(upper)) return "medicare_advantage";
  if (/\bMEDICAID\b/.test(upper)) return "medicaid";
  if (/\bTRICARE\b/.test(upper)) return "tricare";
  if (/\b(CHAMPVA|VETERAN)\b/.test(upper)) return "champva_va";
  if (/\b(FEP|FEDERAL EMPLOYEE)\b/.test(upper)) return "federal_employee";
  if (/\bMEDICARE\b/.test(upper)) return "medicare";
  if (resolver.isGovernmentFunded) return "medicare";
  if (resolver.confidence === "unresolved") return "unknown";
  return "commercial";
}

function patientFriendlyReason(
  resolver: PackageResolverResult,
  category: CoverageCategory
): string {
  if (resolver.confidence === "unresolved") {
    return "We couldn't match this to a plan in our system. Our team will follow up.";
  }
  if (resolver.lowConfidence) {
    return "Please confirm this is your plan, or pick the right one from the list.";
  }
  switch (category) {
    case "medicare":
    case "medicare_advantage":
    case "medicare_supplement":
      return "Medicare coverage confirmed.";
    case "medicaid":
      return "Medicaid coverage confirmed.";
    case "tricare":
      return "TRICARE coverage confirmed.";
    case "champva_va":
      return "Veteran-family coverage confirmed.";
    case "federal_employee":
      return "Federal Employee Program coverage confirmed.";
    case "commercial":
      return "Commercial coverage confirmed.";
    default:
      return "Coverage details on file.";
  }
}
