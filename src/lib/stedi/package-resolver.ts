/**
 * Reverse resolver: 271 NormalizedEligibility → Athena `insurancepackageid`.
 *
 * Two-tier strategy:
 *
 *   1. PRIMARY — Stedi 271 carries `payer.payorIdentification`, which is the
 *      X12 EDI Payer ID. Athena's equivalent column on `insurancepackage` is
 *      `EMCCODE`, mirrored into Supabase as
 *      `portal_insurance_packages.edi_payer_id` by the daily Prefect chain
 *      (mdm-insurance-reference-sync 06:15 CT → portal-insurance-sync 06:30 CT).
 *      We look up by edi_payer_id and, when multiple Athena packages share it
 *      (e.g. all 13 BCBS-MN packages share `00720`), narrow by product-type
 *      hints derived from the brand + 271 plan name.
 *
 *   2. FALLBACK — when Stedi doesn't return a payorIdentification, or the id
 *      isn't in our portal table yet (new payer not yet mirrored), we fall
 *      back to the legacy in-code BRAND_MAPPINGS table. This is what the
 *      resolver did before id-match was introduced; it's not as precise but
 *      it has been validated against the DEV-3961 22-patient run.
 *
 * The 22-patient validation in DEV-3961 also confirmed that for the
 * 11-brand catalog the brand+planName regex trio is sufficient when the
 * id-match path fails, so the legacy table is a real safety net rather
 * than dead code.
 *
 * Why this changed: Anthem BCBS was being mis-classified as a Medicare
 * Advantage government-funded plan because the BCBS catch-all defaulted to
 * a BCBS-MN MA-PPO entry. The id-match primary path resolves Anthem (whose
 * payorIdentification is NOT `00720`) to whatever BCBS variant Athena has,
 * not BCBS-MN MA-PPO. See chat 44d64480-403e-4852-8d6f-dbe69c2dc132.
 */

import {
  lookupPortalInsuranceByEdiPayerId,
  type PortalInsurancePackage,
} from "@/lib/portal/insurance-packages";

import type { PortalPayerBrand } from "./types";
import type { NormalizedEligibility, PackageResolverResult } from "./types";

// ─── Legacy fallback catalog ──────────────────────────────────────────────
// Used only when the id-match primary path can't resolve. See header.

interface DeterministicMapping {
  insurancePackageId: number;
  insurancePlanName: string;
  isGovernmentFunded: boolean;
  /** Optional regex against `planName || ''`, applied case-insensitive. */
  planMatcher?: RegExp;
}

const BRAND_MAPPINGS: Record<string, DeterministicMapping[]> = {
  aetna: [
    {
      insurancePackageId: 3078912,
      insurancePlanName: "AETNA - ALLINA HEALTH (MA-PPO)",
      isGovernmentFunded: true,
    },
  ],
  bcbs: [
    {
      // Federal Employee Program is government-funded (federal employee
      // health benefits). Source data has government_insurance=TRUE,
      // government_funded_type='Federal'. Flow-wise patients with FEP
      // skip the membership step like Medicare/Medicaid patients.
      // See docs/portal/coverage-classification-sanity-check.md.
      insurancePackageId: 77180,
      insurancePlanName: "BCBS-MN FEDERAL EMPLOYEE PROGRAM",
      isGovernmentFunded: true,
      planMatcher: /\b(BASIC|FEP|FEDERAL EMPLOYEE)\b/i,
    },
    {
      insurancePackageId: 111355,
      insurancePlanName: "BCBS-MN MA-PPO",
      isGovernmentFunded: true,
      planMatcher: /\b(MED ADV|MEDICARE ADV|MAPD|MA[- ]?PPO|LPPO)\b/i,
    },
    {
      insurancePackageId: 1132,
      insurancePlanName: "BCBS-MN",
      isGovernmentFunded: false,
    },
  ],
  healthpartners: [
    {
      insurancePackageId: 524891,
      insurancePlanName: "HEALTHPARTNERS (MA-PPO)",
      isGovernmentFunded: true,
    },
  ],
  humana: [
    {
      insurancePackageId: 47006,
      insurancePlanName: "HUMANA (MA-PPO)",
      isGovernmentFunded: true,
    },
  ],
  medica: [
    {
      insurancePackageId: 617523,
      insurancePlanName: "MEDICA GOV PROGRAMS (MA-PPO)",
      isGovernmentFunded: true,
    },
  ],
  tricare: [
    {
      insurancePackageId: 476403,
      insurancePlanName: "TRICARE WEST - TRIWEST",
      isGovernmentFunded: true,
    },
  ],
  ucare: [
    {
      insurancePackageId: 732545,
      insurancePlanName: "UCARE (MEDICAID REPLACEMENT HMO)",
      isGovernmentFunded: true,
    },
  ],
  uhc: [
    {
      insurancePackageId: 70322,
      insurancePlanName: "UNITED HEALTHCARE (MA-PPO)",
      isGovernmentFunded: true,
      planMatcher: /\b(MEDICARE ADVANTAGE|MAPD|LPPO|AARP MEDICARE)\b/i,
    },
    {
      insurancePackageId: 70322,
      insurancePlanName: "UNITED HEALTHCARE (MA-PPO)",
      isGovernmentFunded: true,
    },
  ],
  "va-champva": [
    {
      insurancePackageId: 35331,
      insurancePlanName: "CHAMPVA",
      isGovernmentFunded: true,
    },
  ],
  medicare: [
    {
      insurancePackageId: 77178,
      insurancePlanName: "MEDICARE B-MN: NGS",
      isGovernmentFunded: true,
    },
  ],
  "medicaid-mn": [
    {
      insurancePackageId: 26264,
      insurancePlanName: "MEDICAID-MN",
      isGovernmentFunded: true,
    },
  ],
};

// ─── ID-match primary path ────────────────────────────────────────────────

// Athena `insurance_product_type_id` values. Stable across orgs; sourced
// from `mdm.reference_data.insurance_product_type` (verified 2026-04-25).
// Only the ones the disambiguator needs are named; others are referenced
// numerically when needed.
const PRODUCT_TYPE = {
  HMO: "1",
  PPO: "2",
  POS: "3",
  INDEMNITY: "4",
  OTHER: "5",
  EPO: "6",
  BEHAVIORAL_HEALTH: "8",
  MEDICAID_HMO: "10",
  MEDICAID_TRADITIONAL: "13",
  MEDICARE_HMO: "14",
  MEDICARE_PPO: "15",
  MEDICARE_SUPPLEMENT: "16",
  CONTRACTS: "19",
  MEDICARE_B_TRADITIONAL: "21",
  MEDICARE_PRIVATE_FFS: "22",
} as const;

// Allowed product_type_ids per brand productHint. Used as a *filter*, not an
// ordering: the underlying lookup already orders candidates by
// patient_insurance_count DESC, which is the empirical ordering we want.
// Imposing a hardcoded preference (e.g. "PPO first") is what caused UHC's
// dominant 982 (OTHER, n=94) to lose to 10459 (PPO, n=29) when Stedi returned
// a blank planName. See chat 44d64480-403e-4852-8d6f-dbe69c2dc132.
const ALLOWED_PRODUCT_TYPES_BY_HINT: Record<
  PortalPayerBrand["productHint"],
  ReadonlySet<string>
> = {
  commercial: new Set([
    PRODUCT_TYPE.PPO,
    PRODUCT_TYPE.HMO,
    PRODUCT_TYPE.EPO,
    PRODUCT_TYPE.POS,
    PRODUCT_TYPE.OTHER,
    PRODUCT_TYPE.INDEMNITY,
  ]),
  medicare: new Set([
    PRODUCT_TYPE.MEDICARE_PPO,
    PRODUCT_TYPE.MEDICARE_HMO,
    PRODUCT_TYPE.MEDICARE_SUPPLEMENT,
    PRODUCT_TYPE.MEDICARE_B_TRADITIONAL,
    PRODUCT_TYPE.MEDICARE_PRIVATE_FFS,
  ]),
  medicaid: new Set([
    PRODUCT_TYPE.MEDICAID_HMO,
    PRODUCT_TYPE.MEDICAID_TRADITIONAL,
  ]),
  tricare: new Set([PRODUCT_TYPE.OTHER, PRODUCT_TYPE.PPO]),
  va: new Set([PRODUCT_TYPE.OTHER, PRODUCT_TYPE.PPO]),
  other: new Set([PRODUCT_TYPE.OTHER, PRODUCT_TYPE.PPO]),
};

// EB04 (Insurance Type Code) → allowed Athena `insurance_product_type_id`s.
// EB04 is the most authoritative signal in the 271 — it's a contractual
// X12 enum the payer must populate. UHC, BCBS, Aetna and others all set it
// even when planName is blank, so it lets us route Medicare-Advantage vs
// commercial vs UMR/ASO deterministically. See
// https://x12.org/codes/insurance-descriptor-codes.
//
// `null` set means "any product type allowed" (don't filter).
const ALLOWED_PRODUCT_TYPES_BY_EB04: Record<string, ReadonlySet<string> | null> = {
  C1: new Set([                          // Commercial
    PRODUCT_TYPE.PPO, PRODUCT_TYPE.HMO, PRODUCT_TYPE.POS, PRODUCT_TYPE.EPO,
    PRODUCT_TYPE.OTHER, PRODUCT_TYPE.INDEMNITY, PRODUCT_TYPE.CONTRACTS,
  ]),
  GP: new Set([                          // Group Policy (UMR / ASO / self-funded)
    PRODUCT_TYPE.OTHER, PRODUCT_TYPE.PPO, PRODUCT_TYPE.POS,
    PRODUCT_TYPE.HMO, PRODUCT_TYPE.EPO, PRODUCT_TYPE.CONTRACTS,
  ]),
  PR: new Set([                          // PPO — could be commercial or Medicare Adv
    PRODUCT_TYPE.PPO, PRODUCT_TYPE.MEDICARE_PPO,
  ]),
  PS: new Set([PRODUCT_TYPE.POS]),       // POS
  OA: new Set([PRODUCT_TYPE.POS]),       // Open Access POS
  HM: new Set([                          // HMO
    PRODUCT_TYPE.HMO, PRODUCT_TYPE.MEDICARE_HMO, PRODUCT_TYPE.MEDICAID_HMO,
  ]),
  HN: new Set([PRODUCT_TYPE.MEDICARE_HMO]), // HMO Medicare Risk
  EP: new Set([PRODUCT_TYPE.EPO]),       // Exclusive Provider Organization
  HD: new Set([                          // High Deductible Health Plan
    PRODUCT_TYPE.PPO, PRODUCT_TYPE.HMO, PRODUCT_TYPE.POS,
    PRODUCT_TYPE.EPO, PRODUCT_TYPE.OTHER,
  ]),
  IN: new Set([PRODUCT_TYPE.INDEMNITY]),
  IP: new Set([PRODUCT_TYPE.INDEMNITY]),
  MA: new Set([                          // Medicare Part A
    PRODUCT_TYPE.MEDICARE_PPO, PRODUCT_TYPE.MEDICARE_HMO,
    PRODUCT_TYPE.MEDICARE_B_TRADITIONAL, PRODUCT_TYPE.MEDICARE_PRIVATE_FFS,
    PRODUCT_TYPE.MEDICARE_SUPPLEMENT,
  ]),
  MB: new Set([                          // Medicare Part B
    PRODUCT_TYPE.MEDICARE_PPO, PRODUCT_TYPE.MEDICARE_HMO,
    PRODUCT_TYPE.MEDICARE_B_TRADITIONAL, PRODUCT_TYPE.MEDICARE_PRIVATE_FFS,
    PRODUCT_TYPE.MEDICARE_SUPPLEMENT,
  ]),
  MC: new Set([                          // Medicaid
    PRODUCT_TYPE.MEDICAID_HMO, PRODUCT_TYPE.MEDICAID_TRADITIONAL,
  ]),
  QM: new Set([                          // Medicare Risk - dual eligible
    PRODUCT_TYPE.MEDICARE_HMO, PRODUCT_TYPE.MEDICAID_HMO,
  ]),
  SP: null,                              // Supplemental — payer-dependent, don't filter
  TF: new Set([PRODUCT_TYPE.OTHER]),     // TRICARE / Federal Family
  WU: null,                              // Wraparound — don't filter
  OT: null,                              // Other — don't filter
};

/**
 * Map plan-name / group-name signal in the 271 to a specific
 * `insurance_product_type_id`. Returns null when no strong signal —
 * caller falls back to brand-hint preference.
 */
function inferProductTypeIdFromPlanLine(planLine: string): string | null {
  if (!planLine) return null;
  // Order matters: more specific patterns first so e.g. "Medicare PPO"
  // beats the generic "PPO" rule.
  if (/\b(MA[- ]?PPO|MEDICARE\s+(PPO|ADVANTAGE\s+PPO)|LPPO|MAPD\s+PPO)\b/i.test(planLine)) {
    return PRODUCT_TYPE.MEDICARE_PPO;
  }
  if (/\b(MA[- ]?HMO|MEDICARE\s+(HMO|ADVANTAGE\s+HMO)|MAPD\s+HMO|MEDICARE\s+REPLACEMENT)\b/i.test(planLine)) {
    return PRODUCT_TYPE.MEDICARE_HMO;
  }
  if (/\b(MEDIGAP|MEDICARE\s+SUPP|MED\s+SUPP|SUPPLEMENT)\b/i.test(planLine)) {
    return PRODUCT_TYPE.MEDICARE_SUPPLEMENT;
  }
  if (/\bMEDICAID\s+HMO\b/i.test(planLine)) return PRODUCT_TYPE.MEDICAID_HMO;
  if (/\bMEDICAID\b/i.test(planLine)) return PRODUCT_TYPE.MEDICAID_TRADITIONAL;
  if (/\bEPO\b/i.test(planLine)) return PRODUCT_TYPE.EPO;
  if (/\bPOS\b/i.test(planLine)) return PRODUCT_TYPE.POS;
  if (/\bHMO\b/i.test(planLine)) return PRODUCT_TYPE.HMO;
  if (/\bPPO\b/i.test(planLine)) return PRODUCT_TYPE.PPO;
  if (/\bINDEMNITY\b/i.test(planLine)) return PRODUCT_TYPE.INDEMNITY;
  // Generic Medicare cues (AARP MEDICARE COMPLETE, MEDICARE ADVANTAGE without
  // PPO/HMO suffix, etc.). PPO is the more common Medicare Advantage variant
  // in our population per the eligibilitytrack 365-day analysis.
  if (/\b(AARP|MEDICARE\s+ADVANTAGE|MEDICARE\s+COMPLETE|MEDICARE)\b/i.test(planLine)) {
    return PRODUCT_TYPE.MEDICARE_PPO;
  }
  return null;
}

// Ordered specific-package overrides keyed off (ediPayerId, signal). When a
// signal matches we resolve straight to a specific Athena package id without
// going through the generic filter+ordering logic. Use sparingly — only for
// plan-family tokens we've validated against samples (≥80% purity). The
// generic path correctly handles the long tail.
//
// Sources: docs/stedi/disambiguation-uhc-2026-04.md (UHC 77 sample) and
// docs/stedi/disambiguation-humana-tricare-2026-04.md (Humana/TRICARE 50).
interface PackageOverrideRule {
  /** Stedi payer EDI id this rule applies to. */
  ediPayerId: string;
  /** Optional EB04 filter — when set, the eligibility must match. */
  eb04?: string;
  /** Regex tested against `${planName} ${groupName} ${memberId}`. Case-insensitive. */
  signal: RegExp;
  /** Athena insurance_package_id to route to. */
  packageId: number;
  /** Short label for logs / breadcrumbs. */
  label: string;
}

const PACKAGE_OVERRIDES: PackageOverrideRule[] = [
  // ─── UHC 87726 ────────────────────────────────────────────────────────
  // Surest: plan name contains "SUREST" or distinctive Surest product codes
  // (`25 FI MN`, `25 FI ##`, `26 BB`, `26 FI`). Validated against
  // docs/stedi/disambiguation-uhc-2026-04.md sample (5/5 Surest patients
  // had at least one of these tokens). `26 BB SUREST` matches both rules
  // intentionally — first one wins, both route to 746442 anyway.
  {
    ediPayerId: "87726", eb04: "C1",
    signal: /\bSUREST\b|\b25\s*FI(?:\s*MN|\s*\d{2})\b|\b26\s*(?:BB|FI)\s+\S/i,
    packageId: 746442, label: "uhc-surest",
  },
  // UHC AARP Medicare Advantage PPO. EB04=PR is the deterministic signal
  // (also picked up by the dominant-package map below), but plan-name is a
  // belt-and-suspenders override for cases where EB04 is missing or the
  // 271 carries `MEDICARE ADVANTAGE` without "PPO" suffix (e.g. Florida
  // group plans like "HMOPOS-UHC THE VILLAGES MEDICARE ADVANTAGE FL-004P"
  // which is still routed through the same MA-PPO Athena package).
  {
    ediPayerId: "87726",
    signal: /\b(LPPO|HMOPOS|MA[- ]?PPO|MEDICARE\s+ADVANTAGE|MEDICARE\s+COMPLETE|AARP\s+MEDICARE)\b/i,
    packageId: 70322, label: "uhc-ma-ppo",
  },
];

// Fallback dominant-package map per (EDI, EB04). Used ONLY when nothing
// else (override rule, plan-name hint, brand-hint filter) has narrowed the
// pool. This compensates for the fact that
// `portal_insurance_packages.patient_insurance_count` is currently always
// 0 (Prefect sync TODO), so the lookup ordering falls through to
// `insurance_package_id ASC` which doesn't reflect real popularity.
//
// Numbers come from docs/stedi/disambiguation-uhc-2026-04.md and the
// Humana/TRICARE 2026-04 sample. Remove this map once
// patient_insurance_count is properly populated from Athena.
const DOMINANT_PACKAGE_BY_EDI_EB04: Record<string, Record<string, number>> = {
  "87726": {                  // UnitedHealthcare gateway (covers UHC + UMR + Surest)
    PR: 70322,                // Medicare Advantage PPO (dominant Medicare bucket)
    C1: 982,                  // Commercial — 982 wins by volume per Athena truth
    GP: 149947,               // UMR / ASO — dominant UMR package
    HM: 70322,                // HMO — usually MA-HMO, route to MA bucket
    HD: 982,                  // HDHP — falls into commercial bucket
    EP: 982,                  // EPO
    PS: 70322,                // POS — usually MA HMO-POS variant for UHC
    DEFAULT: 982,             // No EB04 + no plan signal → most common UHC commercial package
  },
};
const DOMINANT_DEFAULT_KEY = "DEFAULT";

function applyOverrides(
  ediPayerId: string,
  eligibility: NormalizedEligibility,
  candidates: PortalInsurancePackage[],
  memberIdHint?: string,
): { picked: PortalInsurancePackage; reason: string } | null {
  const corpus = [
    eligibility.planName ?? "",
    eligibility.groupName ?? "",
    memberIdHint ?? "",
  ].join(" ");
  for (const rule of PACKAGE_OVERRIDES) {
    if (rule.ediPayerId !== ediPayerId) continue;
    if (rule.eb04 && eligibility.primaryInsuranceTypeCode !== rule.eb04) continue;
    if (!rule.signal.test(corpus)) continue;
    const picked = candidates.find((c) => c.insurancepackageid === rule.packageId);
    if (picked) {
      return {
        picked,
        reason: `override=${rule.label} signal=${rule.signal.source}`,
      };
    }
  }
  return null;
}

/**
 * Pick the best candidate from a list that all share the same edi_payer_id.
 *
 * Strategy (highest precedence first):
 *   0. Specific override rules (e.g. UHC Surest, UHC MA-PPO by plan-name).
 *   1. Filter candidates by EB04 (Insurance Type Code) — the most authoritative
 *      X12 signal. UHC, BCBS, Aetna all populate it even when planName is blank.
 *   2. Filter further by `inferProductTypeIdFromPlanLine` when the plan name
 *      strongly hints at a sub-type.
 *   3. Filter by brand productHint allowed-set.
 *   4. Pick the first remaining candidate. The lookup already sorted by
 *      patient_insurance_count DESC, so this is the empirically most-common
 *      package and matches the right answer for the long tail.
 */
/**
 * Apply the resolver's classification rule (see
 * docs/portal/coverage-classification-sanity-check.md):
 *
 *   1. `government_funded_type IS NOT NULL` → government.
 *   2. `insurance_product_type LIKE 'Medicare%'` → government (catches
 *      Medicare Supplemental Plan, which has government_insurance=NULL but
 *      is paired with Medicare-as-primary).
 *   3. `insurance_product_type LIKE 'Medicaid%'` → government.
 *   4. Otherwise → whatever the source row says.
 */
function classifyAsGovernmentFunded(pkg: PortalInsurancePackage): boolean {
  if (pkg.governmentFundedType) return true;
  const pt = pkg.insuranceProductType ?? "";
  if (/^Medicare/i.test(pt)) return true;
  if (/^Medicaid/i.test(pt)) return true;
  return pkg.isGovernmentFunded;
}

/** Dominant-package map fallback when patient_insurance_count is unreliable. */
function pickDominantPackageCandidate(
  ediId: string,
  eb04: string | null,
  finalPool: PortalInsurancePackage[]
): { picked: PortalInsurancePackage; reason: string } | null {
  const ediMap = DOMINANT_PACKAGE_BY_EDI_EB04[ediId];
  if (!ediMap) return null;
  const lookupKey = eb04 ?? DOMINANT_DEFAULT_KEY;
  const dominantId = ediMap[lookupKey] ?? ediMap[DOMINANT_DEFAULT_KEY];
  if (dominantId === null || dominantId === undefined) return null;
  const dom = finalPool.find((c) => c.insurancepackageid === dominantId);
  if (!dom) return null;
  return {
    picked: dom,
    reason: `eb04=${eb04 ?? "none"} dominant-package=${dominantId} (patient_insurance_count broken; see DEV-XXXX)`,
  };
}

function pickFromCandidates(
  brand: PortalPayerBrand,
  eligibility: NormalizedEligibility,
  candidates: PortalInsurancePackage[]
): { picked: PortalInsurancePackage; reason: string; lowConfidence: boolean } {
  if (candidates.length === 1) {
    return { picked: candidates[0], reason: "single-candidate", lowConfidence: false };
  }

  // 0. Override rules — bypass everything else when matched. Overrides are
  //    sample-validated (≥80% purity), so they're high-confidence by design.
  const ediId = (eligibility.payerEdiId ?? "").trim();
  if (ediId) {
    const override = applyOverrides(ediId, eligibility, candidates);
    if (override) return { ...override, lowConfidence: false };
  }

  const planLine = [eligibility.planName ?? "", eligibility.groupName ?? ""]
    .join(" ")
    .trim();
  const eb04 = eligibility.primaryInsuranceTypeCode;

  // 1. Apply EB04 filter (when both EB04 and a known mapping are present).
  let pool = candidates;
  if (eb04) {
    const allowed = ALLOWED_PRODUCT_TYPES_BY_EB04[eb04];
    if (allowed) {
      const filtered = pool.filter(
        (c) =>
          c.insuranceProductTypeId !== null &&
          c.insuranceProductTypeId !== undefined &&
          allowed.has(c.insuranceProductTypeId),
      );
      if (filtered.length > 0) pool = filtered;
    }
  }

  // 2. Plan-name → product-type strong signal (preserved from previous logic).
  const planHint = inferProductTypeIdFromPlanLine(planLine);
  if (planHint) {
    const match = pool.find((c) => c.insuranceProductTypeId === planHint);
    if (match) {
      return {
        picked: match,
        reason: `eb04=${eb04 ?? "none"} plan-line-product-type=${planHint} planLine="${planLine.slice(0, 80)}"`,
        lowConfidence: false,
      };
    }
  }

  // 3. Brand-hint allowed-set filter (don't pick a Medicare package for a
  //    commercial brand even if it's the most popular).
  const allowedByBrand =
    ALLOWED_PRODUCT_TYPES_BY_HINT[brand.productHint] ??
    ALLOWED_PRODUCT_TYPES_BY_HINT.other;
  const brandFiltered = pool.filter(
    (c) =>
      c.insuranceProductTypeId !== null &&
      c.insuranceProductTypeId !== undefined &&
      allowedByBrand.has(c.insuranceProductTypeId),
  );
  const finalPool = brandFiltered.length > 0 ? brandFiltered : pool;

  // 4. Dominant-package map fallback per (EDI, EB04).
  if (ediId) {
    const dominant = pickDominantPackageCandidate(ediId, eb04, finalPool);
    if (dominant) {
      return { ...dominant, lowConfidence: true };
    }
  }

  // 5. Pick the head — ordered by patient_insurance_count DESC by the lookup
  //    (currently degenerate to id ASC since the column is always 0).
  //    Multiple candidates with no narrowing signal → low-confidence.
  return {
    picked: finalPool[0],
    reason: `eb04=${eb04 ?? "none"} brand=${brand.brandId} most-popular-of-${finalPool.length} (filtered from ${candidates.length})`,
    lowConfidence: finalPool.length > 1,
  };
}

// ─── Public resolver ──────────────────────────────────────────────────────

/** Injectable dependencies for the insurance package resolver. */
export interface ResolverDeps {
  /**
   * Lookup hook — defaults to the live Supabase reader. Override in tests.
   * Returns all active portal_insurance_packages rows whose edi_payer_id
   * matches.
   */
  lookupByEdiPayerId?: (
    ediPayerId: string
  ) => Promise<PortalInsurancePackage[]>;
}

/**
 * Reverse-resolve a 271 to an Athena insurance_package_id.
 *
 * Async because the primary path queries Supabase. The legacy fallback path
 * is in-process (BRAND_MAPPINGS), so callers that already have a Supabase
 * outage will still get a usable answer — just at lower confidence.
 */
export async function resolvePackageFromEligibility(
  brand: PortalPayerBrand,
  eligibility: NormalizedEligibility,
  deps: ResolverDeps = {}
): Promise<PackageResolverResult> {
  const lookup =
    deps.lookupByEdiPayerId ?? lookupPortalInsuranceByEdiPayerId;

  // ── Primary: id-match against portal_insurance_packages.edi_payer_id ──
  if (eligibility.payerEdiId) {
    let candidates: PortalInsurancePackage[] = [];
    try {
      candidates = await lookup(eligibility.payerEdiId);
    } catch (err) {
      // Supabase unavailable / column missing — log and fall through to
      // the legacy table. Don't blow up the registration flow.
      const msg = err instanceof Error ? err.message : String(err);
      const fallback = resolvePackageFromBrandTable(brand, eligibility);
      return {
        ...fallback,
        reason: `id-match lookup failed (${msg.slice(0, 120)}); ${fallback.reason}`,
      };
    }

    if (candidates.length > 0) {
      const { picked, reason, lowConfidence } = pickFromCandidates(
        brand,
        eligibility,
        candidates
      );
      return {
        insurancePackageId: picked.insurancepackageid,
        insurancePlanName: picked.insuranceplanname,
        isGovernmentFunded: classifyAsGovernmentFunded(picked),
        confidence: "id-match",
        lowConfidence,
        reason: `edi_payer_id=${eligibility.payerEdiId} brand=${brand.brandId} ${reason}`,
      };
    }

    // edi_payer_id present but unknown to us — fall through to legacy table
    // and annotate the reason so Sentry can show why.
    const fallback = resolvePackageFromBrandTable(brand, eligibility);
    return {
      ...fallback,
      reason: `edi_payer_id=${eligibility.payerEdiId} not in portal_insurance_packages; ${fallback.reason}`,
    };
  }

  // ── No payerIdentification on the 271 — legacy brand table only ──
  return resolvePackageFromBrandTable(brand, eligibility);
}

/**
 * Legacy (pre-id-match) resolver. Still exported for tests + as the
 * fallback path inside the main resolver.
 */
export function resolvePackageFromBrandTable(
  brand: PortalPayerBrand,
  eligibility: NormalizedEligibility
): PackageResolverResult {
  const candidates = BRAND_MAPPINGS[brand.brandId] ?? [];
  if (candidates.length === 0) {
    return {
      insurancePackageId: null,
      insurancePlanName: null,
      isGovernmentFunded: brand.isGovernmentFunded,
      confidence: "unresolved",
      lowConfidence: true,
      reason: `No mapping table for brand=${brand.brandId}`,
    };
  }

  const planLine = [eligibility.planName ?? "", eligibility.groupName ?? ""]
    .join(" ")
    .trim();

  for (const candidate of candidates) {
    if (!candidate.planMatcher) continue;
    if (candidate.planMatcher.test(planLine)) {
      return {
        insurancePackageId: candidate.insurancePackageId,
        insurancePlanName: candidate.insurancePlanName,
        isGovernmentFunded: candidate.isGovernmentFunded,
        confidence: "heuristic",
        lowConfidence: false,
        reason: `brand=${brand.brandId} planMatcher=${candidate.planMatcher} planLine="${planLine.slice(0, 80)}"`,
      };
    }
  }

  const fallback = candidates.find((c) => !c.planMatcher) ?? candidates[0];
  const isDeterministic =
    candidates.length === 1 || candidates.every((c) => !c.planMatcher);

  return {
    insurancePackageId: fallback.insurancePackageId,
    insurancePlanName: fallback.insurancePlanName,
    isGovernmentFunded: fallback.isGovernmentFunded,
    confidence: isDeterministic ? "deterministic" : "fallback",
    lowConfidence: !isDeterministic,
    reason: `brand=${brand.brandId} fallback=true planLine="${planLine.slice(0, 80)}"`,
  };
}
