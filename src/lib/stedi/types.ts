/**
 * Shared types for the Stedi eligibility integration.
 *
 * The portal sends a clean carrier brand from the patient-facing picker; the
 * server resolves that to a Stedi `tradingPartnerServiceId`, runs a 270/271,
 * reverse-resolves the 271 back to the right Athena `insurancepackageid`,
 * and returns a `NormalizedEligibility` to the wizard so the result view
 * can render plan / network / copay / deductible without parsing X12.
 */

/** Curated patient-facing brand entry. Single source of truth for the picker. */
export interface PortalPayerBrand {
  /** Stable brand id used by the wizard + reverse resolver lookups. */
  brandId: string;
  /** What the patient sees on the card. */
  displayName: string;
  /** Optional second line under displayName (e.g. "Anthem / regional Blues"). */
  subtitle?: string;
  /** Order in the picker (smaller = earlier). */
  orderIndex: number;
  /** Default Stedi tradingPartnerServiceId attempted on the first 270. */
  defaultStediPayerId: string;
  /** Optional fallbacks if the first call returns 400/AAA*41. */
  altStediPayerIds?: string[];
  /** Hint for downstream UX (e.g. show MBI mask, hide group field, govt-funded badge). */
  productHint: "commercial" | "medicare" | "medicaid" | "tricare" | "va" | "other";
  /** True when this brand maps to a government-funded plan (skips membership step). */
  isGovernmentFunded: boolean;
  /** True when the patient should see a "we'll verify at the clinic" handoff instead of a real call. */
  guidedHandoff?: boolean;
  /** True when Stedi requires payer-specific enrollment we haven't completed yet. UI explains the soft-fallback. */
  enrollmentPending?: boolean;
}

/** Patient-friendly view of an X12 271 response. */
export interface NormalizedEligibility {
  /** "Active Coverage" | "Inactive" | "Unknown" — never a raw status code. */
  coverageStatus: "active" | "inactive" | "unknown";
  /** Carrier as returned by the 271 (e.g. "BCBSMN", "AETNA INC"). */
  payerName: string | null;
  /**
   * X12 EDI Payer ID returned in 271 `payer.payorIdentification`. Stable
   * cross-payer identifier (e.g. `00720` for BCBS-MN, `87726` for UHC). Used
   * by the package resolver as the primary key to look up the right Athena
   * `insurance_package_id` against `portal_insurance_packages.edi_payer_id`,
   * which is the same value sourced from Athena's `EMCCODE`.
   */
  payerEdiId: string | null;
  /** Plan label for the result view (e.g. "Allina Health Aetna Medicare Enhanced (PPO)"). */
  planName: string | null;
  /** Group number on the patient's card, when surfaced by the payer. */
  groupNumber: string | null;
  /** Group / employer description (e.g. "Medicare JV - Allina - MAPD"). */
  groupName: string | null;
  /** YYYY-MM-DD plan begin / end if present. */
  planBeginDate: string | null;
  planEndDate: string | null;
  /** When the responder explicitly stated coverage runs through (eligibilityEnd). */
  coveredThrough: string | null;
  /** X12 Service Type Codes the payer reported (30, MH, BZ, …). UI ignores by default. */
  activeServiceTypes: string[];
  /**
   * EB04 Insurance Type Code aggregated across the primary subscriber's
   * benefit segments. The most-frequent non-null value wins. Examples:
   *   `C1` Commercial · `GP` Group Policy · `PR` PPO · `PS` POS · `HM` HMO
   *   `HD` HDHP · `EP` EPO · `MA` Medicare Part A · `MB` Part B
   *   `MC` Medicaid · `OT` Other
   * UHC uses this to separate commercial-fully-insured (`C1`) from UMR/ASO
   * (`GP`) from Medicare Advantage (`PR`/`HM`), even when planName is blank.
   * Null when the payer doesn't populate EB04 on primary benefits.
   */
  primaryInsuranceTypeCode: string | null;
  /**
   * Coordination of Benefits — Other Payers reported in Loop 2120C.
   * Used by the Medicare disambiguation flow to retry against an MA carrier.
   */
  otherPayers: NormalizedOtherPayer[];
  /** Raw AAA codes returned (rejection reasons). Empty on a clean 271. */
  rejectionCodes: string[];
}

/** Secondary/other payer row normalized from a Stedi 271. */
export interface NormalizedOtherPayer {
  name: string | null;
  ediId: string | null;
  insuranceTypeCode: string | null;
}

/** Result of the forward resolver: brand → Stedi payer call. */
export interface BrandResolverResult {
  brand: PortalPayerBrand;
  /** Ordered list of tradingPartnerServiceIds to try (default first, alts after). */
  stediPayerIds: string[];
}

/** Result of the reverse resolver: 271 → Athena insurance package. */
export interface PackageResolverResult {
  insurancePackageId: number | null;
  insurancePlanName: string | null;
  isGovernmentFunded: boolean;
  /**
   * - `id-match`     — primary path: matched on edi_payer_id (X12 payer id),
   *                    optionally narrowed by insurance_product_type_id.
   * - `deterministic`— legacy fallback: brand has exactly one mapping.
   * - `heuristic`    — legacy fallback: regex match on planName/groupName.
   * - `fallback`     — legacy fallback: brand catch-all entry.
   * - `unresolved`   — no mapping found at all.
   */
  confidence:
  | "id-match"
  | "deterministic"
  | "heuristic"
  | "fallback"
  | "unresolved";
  /**
   * True when the resolver had to lean on the `DOMINANT_PACKAGE_BY_EDI_EB04`
   * hot-fix map or the legacy fallback because the upstream `id-match` path
   * had multiple equally-plausible candidates and the 271 carried no
   * narrowing signal (blank planName + no EB04). The UI should promote the
   * plan-name confirmation card to a *required* step in this case so the
   * patient confirms (or corrects) the resolver's pick before scheduling.
   */
  lowConfidence: boolean;
  /** Why we landed where we did (for Sentry breadcrumbs). */
  reason: string;
}
