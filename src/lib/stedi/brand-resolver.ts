/**
 * Forward resolver: patient-facing brand → ordered list of Stedi
 * tradingPartnerServiceIds to try.
 *
 * Phase 1 keeps the catalog as an in-code constant. Per the integration plan,
 * this moves to the Supabase `portal_payer_brand` table in Phase 2 and the
 * BCBS BlueCard 3-letter prefix table is added at the same time. The function
 * signature is shaped so that change is a drop-in swap (loader becomes async,
 * callers already await).
 *
 * The 11 brand entries cover 98.30% of historical Athena eligibility traffic
 * (validated against `eligibilitytrack` over the trailing 365 days). The IDs
 * below are the first-attempt Stedi payer IDs proven against real Herself
 * Health patients in the DEV-3961 22-patient validation run.
 */

import type {
  BrandResolverResult,
  PortalPayerBrand,
} from "./types";

/**
 * Curated brand catalog. Order matters — first 8 entries are the high-volume
 * commercial / MA carriers; the next 3 are the gov / specialty payers; the
 * final entry is the guided-handoff path for the ~1.7% residual.
 */
export const PORTAL_PAYER_BRANDS: PortalPayerBrand[] = [
  {
    brandId: "bcbs",
    displayName: "Blue Cross Blue Shield",
    subtitle: "Any Blue plan, including Anthem",
    orderIndex: 1,
    defaultStediPayerId: "00720",
    // BCBS member IDs starting with non-MN BlueCard alpha-prefixes (Anthem,
    // Empire, Highmark, etc.) need to fall through to the Anthem multistate
    // gateway. The runner tries IDs in order and returns the first one with
    // no AAA error, so safe to add as fallbacks. See
    // docs/portal/coverage-classification-sanity-check.md.
    altStediPayerIds: ["00040", "00803", "89200"],
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "medicare",
    displayName: "Medicare",
    subtitle: "Original Medicare or Medicare Advantage",
    orderIndex: 2,
    defaultStediPayerId: "CMS",
    altStediPayerIds: ["06202", "SMDCR"],
    productHint: "medicare",
    isGovernmentFunded: true,
    enrollmentPending: true,
  },
  {
    brandId: "uhc",
    displayName: "UnitedHealthcare",
    subtitle: "Includes AARP and UMR",
    orderIndex: 3,
    defaultStediPayerId: "87726",
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "ucare",
    displayName: "UCare",
    subtitle: "Includes UCare Connect and MinnesotaCare",
    orderIndex: 4,
    defaultStediPayerId: "55413",
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "aetna",
    displayName: "Aetna",
    subtitle: "Includes Allina Health | Aetna",
    orderIndex: 5,
    defaultStediPayerId: "60054",
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "medica",
    displayName: "Medica",
    subtitle: "Medica plans",
    orderIndex: 6,
    defaultStediPayerId: "MEDM1",
    altStediPayerIds: ["94265"],
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "healthpartners",
    displayName: "HealthPartners",
    subtitle: "Includes HealthPartners | Cigna",
    orderIndex: 7,
    defaultStediPayerId: "94267",
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "humana",
    displayName: "Humana",
    subtitle: "Humana plans",
    orderIndex: 8,
    defaultStediPayerId: "61101",
    productHint: "commercial",
    isGovernmentFunded: false,
  },
  {
    brandId: "tricare",
    displayName: "TRICARE",
    subtitle: "TRICARE Prime, Select, or Reserve",
    orderIndex: 9,
    // MN is in the TRICARE East region. Stedi's tradingPartnerServiceId for
    // TRICARE East is 99727 (alias IYHIG). 99726 is TRICARE West and was
    // returning AAA*75 for our MN patients in the 2026-04 sample run.
    defaultStediPayerId: "99727",
    altStediPayerIds: ["IYHIG", "99726"],
    productHint: "tricare",
    isGovernmentFunded: true,
  },
  {
    brandId: "tricare-for-life",
    displayName: "TRICARE for Life",
    subtitle: "For Medicare-eligible military retirees",
    orderIndex: 9.5,
    // TRICARE for Life is administered by WPS Military and Veterans Health
    // (separate contract from Humana Military / TRICARE East 99727). Stedi's
    // TFL payer is stediId=EPIVM (primaryPayerId=TDFIC). Common aliases
    // observed in the wild include 12X43, TRLIF, TDDIR. Stedi does NOT
    // accept the WPS commercial EDI ID 12C20 here — it returns 400.
    defaultStediPayerId: "TDFIC",
    altStediPayerIds: ["EPIVM", "12X43", "TRLIF"],
    productHint: "tricare",
    isGovernmentFunded: true,
  },
  {
    brandId: "medicaid-mn",
    displayName: "Minnesota Medicaid",
    subtitle: "MN Health Care Programs",
    orderIndex: 10,
    defaultStediPayerId: "DPWMN",
    altStediPayerIds: ["JSZHK", "MNMCD"],
    productHint: "medicaid",
    isGovernmentFunded: true,
    enrollmentPending: true,
  },
  {
    brandId: "va-champva",
    displayName: "VA or CHAMPVA",
    subtitle: "Veterans and qualifying family members",
    orderIndex: 11,
    defaultStediPayerId: "84146",
    productHint: "va",
    isGovernmentFunded: true,
  },
  {
    brandId: "other",
    displayName: "I don't see my plan",
    subtitle: "Our team will verify your insurance with you",
    orderIndex: 99,
    defaultStediPayerId: "",
    productHint: "other",
    isGovernmentFunded: false,
    guidedHandoff: true,
  },
];

const BY_ID = new Map(PORTAL_PAYER_BRANDS.map((b) => [b.brandId, b]));

/** Return portal payer brands sorted for UI display. */
export function listPortalPayerBrands(): PortalPayerBrand[] {
  return PORTAL_PAYER_BRANDS.slice().sort((a, b) => a.orderIndex - b.orderIndex);
}

/** Look up a portal payer brand by id, or null when unknown. */
export function getBrand(brandId: string): PortalPayerBrand | null {
  return BY_ID.get(brandId) ?? null;
}

/**
 * Resolve a brand to the ordered list of Stedi payer IDs we should try.
 * Returns `null` for the "other" / handoff brand — caller routes the patient
 * to the manual flow instead of calling Stedi.
 */
export function resolveBrandForStedi(
  brandId: string
): BrandResolverResult | null {
  const brand = getBrand(brandId);
  if (!brand) return null;
  if (brand.guidedHandoff || !brand.defaultStediPayerId) return null;
  const ids = [brand.defaultStediPayerId, ...(brand.altStediPayerIds ?? [])];
  return { brand, stediPayerIds: ids };
}

/**
 * Decide the next Stedi payer ID to try after a 271 comes back with a
 * Coordination-of-Benefits Other Payer (Loop 2120C). Today this is only used
 * for Medicare → Medicare Advantage carrier hand-off; capped at 1 retry per
 * the plan.
 *
 * Maps the carrier name in the 271 OtherPayer entry to a brand we can re-call.
 */
export function pickRetryBrandFromOtherPayer(
  otherPayerName: string | null
): PortalPayerBrand | null {
  if (!otherPayerName) return null;
  const upper = otherPayerName.toUpperCase();
  if (upper.includes("UNITED")) return getBrand("uhc");
  if (upper.includes("AETNA")) return getBrand("aetna");
  if (upper.includes("BLUE") || upper.includes("BCBS")) return getBrand("bcbs");
  if (upper.includes("HEALTHPARTNERS") || upper.includes("HEALTH PARTNERS"))
    return getBrand("healthpartners");
  if (upper.includes("HUMANA")) return getBrand("humana");
  if (upper.includes("UCARE")) return getBrand("ucare");
  if (upper.includes("MEDICA")) return getBrand("medica");
  return null;
}
