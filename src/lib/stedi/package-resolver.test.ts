// @vitest-environment node
import { describe, it, expect } from "vitest";

import type { PortalInsurancePackage } from "@/lib/portal/insurance-packages";

import { getBrand } from "./brand-resolver";
import {
  resolvePackageFromBrandTable,
  resolvePackageFromEligibility,
} from "./package-resolver";
import type { NormalizedEligibility } from "./types";
import { toPlanDisplay } from "@/lib/portal/plan-display";

function elig(
  overrides: Partial<NormalizedEligibility> = {}
): NormalizedEligibility {
  return {
    coverageStatus: "active",
    payerName: null,
    payerEdiId: null,
    planName: null,
    groupNumber: null,
    groupName: null,
    planBeginDate: null,
    planEndDate: null,
    coveredThrough: null,
    activeServiceTypes: [],
    primaryInsuranceTypeCode: null,
    otherPayers: [],
    rejectionCodes: [],
    ...overrides,
  };
}

function pkg(
  overrides: Partial<PortalInsurancePackage> = {}
): PortalInsurancePackage {
  return {
    insurancepackageid: 0,
    insuranceplanname: "TEST",
    payorBrand: null,
    payerName: null,
    insuranceProductType: null,
    insuranceProductTypeId: null,
    ediPayerId: null,
    governmentFundedType: null,
    isGovernmentFunded: false,
    ...overrides,
  };
}

/**
 * Stub the Supabase lookup with a fixed catalog. Catalog mirrors the
 * actual `00720` (BCBS-MN) and `87726` (UHC) groupings observed in the
 * Supabase `portal_insurance_packages` table on 2026-04-25, so the tests
 * mirror what the resolver will actually see in production.
 */
function stubLookup(rows: Record<string, PortalInsurancePackage[]>) {
  return async (ediPayerId: string) => rows[ediPayerId] ?? [];
}

const BCBS_MN_BY_PRODUCT: PortalInsurancePackage[] = [
  pkg({
    insurancepackageid: 1132,
    insuranceplanname: "BCBS-MN",
    insuranceProductType: "OTHER",
    insuranceProductTypeId: "5",
    ediPayerId: "00720",
    isGovernmentFunded: false,
  }),
  pkg({
    insurancepackageid: 21448,
    insuranceplanname: "BCBS-MN: BCBS MN (PPO)",
    insuranceProductType: "PPO",
    insuranceProductTypeId: "2",
    ediPayerId: "00720",
    isGovernmentFunded: false,
  }),
  pkg({
    insurancepackageid: 25634,
    insuranceplanname: "BCBS-MN: ADVANTAGE HEALTH PLAN (HMO)",
    insuranceProductType: "HMO",
    insuranceProductTypeId: "1",
    ediPayerId: "00720",
    isGovernmentFunded: false,
  }),
  pkg({
    insurancepackageid: 111355,
    insuranceplanname: "BCBS-MN: (MEDICARE REPLACEMENT PPO)",
    insuranceProductType: "Medicare PPO",
    insuranceProductTypeId: "15",
    ediPayerId: "00720",
    governmentFundedType: "Medicare Replacement/Advantage",
    isGovernmentFunded: true,
  }),
  pkg({
    insurancepackageid: 143221,
    insuranceplanname: "BCBS OF MN: SECURE BLUE (MEDICARE REPLACEMENT HMO)",
    insuranceProductType: "Medicare HMO",
    insuranceProductTypeId: "14",
    ediPayerId: "00720",
    governmentFundedType: "Medicare Replacement/Advantage",
    isGovernmentFunded: true,
  }),
];

describe("resolvePackageFromEligibility — id-match primary path", () => {
  const lookup = stubLookup({
    "00720": BCBS_MN_BY_PRODUCT,
    "87726": [
      pkg({
        insurancepackageid: 70322,
        insuranceplanname: "UHC: AARP MEDICARE COMPLETE",
        insuranceProductType: "Medicare PPO",
        insuranceProductTypeId: "15",
        ediPayerId: "87726",
        governmentFundedType: "Medicare Replacement/Advantage",
        isGovernmentFunded: true,
      }),
      pkg({
        insurancepackageid: 10459,
        insuranceplanname: "UHC: COMMERCIAL PPO",
        insuranceProductType: "PPO",
        insuranceProductTypeId: "2",
        ediPayerId: "87726",
        isGovernmentFunded: false,
      }),
    ],
  });

  it("BCBS edi_payer_id=00720 + plan=PPO → BCBS-MN PPO (commercial)", async () => {
    const brand = getBrand("bcbs")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "00720", planName: "BCBS MN PPO" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(21448);
    expect(out.isGovernmentFunded).toBe(false);
  });

  it("BCBS edi_payer_id=00720 + plan=Medicare Replacement HMO → 143221", async () => {
    const brand = getBrand("bcbs")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({
        payerEdiId: "00720",
        planName: "SECURE BLUE MEDICARE REPLACEMENT HMO",
      }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(143221);
    expect(out.isGovernmentFunded).toBe(true);
  });

  it("BCBS edi_payer_id=00720 with no plan-line signal → most-popular commercial package (lookup order)", async () => {
    // Regression test: previously this asserted 21448 (BCBS-MN PPO) because
    // the resolver hardcoded "PPO first" for commercial brands. That heuristic
    // mis-routed UHC's blank-planName commercial patients to a low-volume PPO
    // package (10459) instead of the dominant OTHER package (982). The fix
    // honours the lookup's patient_insurance_count DESC ordering and only
    // *filters* by brand-hint allowed set, not orders by it.
    // See chat 44d64480-403e-4852-8d6f-dbe69c2dc132 + docs/stedi/disambiguation-uhc-2026-04.md.
    const brand = getBrand("bcbs")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "00720" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(1132);
    expect(out.isGovernmentFunded).toBe(false);
  });

  it("EB04=PR routes UHC commercial brand to PPO 10459 (commercial PPO), not Medicare PPO", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "87726", primaryInsuranceTypeCode: "PR" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(10459);
    expect(out.reason).toMatch(/eb04=PR/);
  });

  it("EB04=C1 (commercial) excludes Medicare PPO from the UHC pool", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "87726", primaryInsuranceTypeCode: "C1" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(10459);
    expect(out.reason).toMatch(/eb04=C1/);
  });

  it("UHC plan-name override 'AARP MEDICARE' wins even when EB04 is missing", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({
        payerEdiId: "87726",
        planName: "LPPO-AARP MEDICARE COMPLETE",
        primaryInsuranceTypeCode: null,
      }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(70322);
    expect(out.reason).toMatch(/override=uhc-ma-ppo/);
  });

  it("Anthem BCBS (different edi_payer_id, not in our table) → fallback to commercial catch-all, not Medicare Advantage", async () => {
    const brand = getBrand("bcbs")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({
        payerEdiId: "00910",
        payerName: "Anthem Blue Cross Blue Shield",
        planName: "ANTHEM BCBS PPO",
      }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.isGovernmentFunded).toBe(false);
    expect(out.insurancePackageId).toBe(1132);
    expect(out.reason).toMatch(/edi_payer_id=00910 not in portal_insurance_packages/);
  });

  it("UHC edi_payer_id=87726 + plan=AARP MEDICARE → Medicare PPO 70322", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "87726", planName: "AARP MEDICARE COMPLETE" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(70322);
    expect(out.isGovernmentFunded).toBe(true);
  });

  it("UHC edi_payer_id=87726 + commercial brand hint, no plan signal → commercial PPO", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "87726" }),
      { lookupByEdiPayerId: lookup }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(10459);
    expect(out.isGovernmentFunded).toBe(false);
  });

  it("Supabase lookup throws → falls back to legacy brand table without crashing", async () => {
    const brand = getBrand("bcbs")!;
    const exploding = async () => {
      throw new Error("supabase down");
    };
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "00720", planName: "FEDERAL EMPLOYEE PROGRAM BASIC" }),
      { lookupByEdiPayerId: exploding }
    );
    expect(out.confidence).toBe("heuristic");
    expect(out.insurancePackageId).toBe(77180);
    expect(out.reason).toMatch(/id-match lookup failed/);
  });

  it("271 has no payer.payorIdentification → legacy brand table (deterministic for single-package brand)", async () => {
    const brand = getBrand("aetna")!;
    const out = await resolvePackageFromEligibility(brand, elig(), {
      lookupByEdiPayerId: lookup,
    });
    expect(out.confidence).toBe("deterministic");
    expect(out.insurancePackageId).toBe(3078912);
  });

  it("guided-handoff brand → unresolved", async () => {
    const brand = getBrand("other")!;
    const out = await resolvePackageFromEligibility(brand, elig(), {
      lookupByEdiPayerId: lookup,
    });
    expect(out.confidence).toBe("unresolved");
    expect(out.insurancePackageId).toBeNull();
  });
});

describe("resolvePackageFromBrandTable — legacy fallback table", () => {
  it("returns 'unresolved' for the guided-handoff brand", () => {
    const brand = getBrand("other")!;
    const out = resolvePackageFromBrandTable(brand, elig());
    expect(out.confidence).toBe("unresolved");
    expect(out.insurancePackageId).toBeNull();
  });

  it("returns 'deterministic' for single-package brands", () => {
    for (const brandId of [
      "aetna",
      "healthpartners",
      "humana",
      "medica",
      "tricare",
      "ucare",
      "va-champva",
      "medicare",
      "medicaid-mn",
    ]) {
      const brand = getBrand(brandId)!;
      const out = resolvePackageFromBrandTable(brand, elig());
      expect(out.insurancePackageId).not.toBeNull();
      expect(out.confidence).toBe("deterministic");
    }
  });

  it("matches BCBS FEP via planMatcher → BCBS-MN FEP package (government-funded)", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "FEDERAL EMPLOYEE PROGRAM BASIC" })
    );
    expect(out.confidence).toBe("heuristic");
    expect(out.insurancePackageId).toBe(77180);
    // FEP is federal employee health benefits — patients should skip the
    // membership step like Medicare/Medicaid patients do. Source data
    // reports government_insurance=TRUE, government_funded_type='Federal'.
    expect(out.isGovernmentFunded).toBe(true);
  });

  it("matches BCBS Medicare Advantage via planMatcher → MA-PPO package", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "BCBS MEDICARE ADVANTAGE LPPO" })
    );
    expect(out.confidence).toBe("heuristic");
    expect(out.insurancePackageId).toBe(111355);
  });

  it("falls back to BCBS COMMERCIAL catch-all when no planMatcher hits", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "BCBS Plain PPO" })
    );
    expect(out.confidence).toBe("fallback");
    expect(out.insurancePackageId).toBe(1132);
    expect(out.isGovernmentFunded).toBe(false);
  });

  it("Anthem BCBS commercial PPO does not get classified as government", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({
        payerName: "Anthem Blue Cross Blue Shield",
        planName: "ANTHEM BCBS PPO",
      })
    );
    expect(out.isGovernmentFunded).toBe(false);
    expect(out.insurancePackageId).toBe(1132);
  });

  it("matches UHC AARP plan name via planMatcher", () => {
    const brand = getBrand("uhc")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "AARP MEDICARE COMPLETE" })
    );
    expect(out.confidence).toBe("heuristic");
    expect(out.insurancePackageId).toBe(70322);
  });
});

describe("classification — Medicare/MA/Government vs Commercial", () => {
  // Mirrors the data-side findings in
  // docs/portal/coverage-classification-sanity-check.md
  it("Medicare Supplemental Plan is treated as government-funded even when source row has government_insurance=NULL", async () => {
    const brand = getBrand("bcbs")!;
    const out = await resolvePackageFromEligibility(
      brand,
      elig({ payerEdiId: "00720", planName: "BCBS MN MEDICARE SUPPLEMENT" }),
      {
        lookupByEdiPayerId: async () => [
          {
            insurancepackageid: 37000,
            insuranceplanname: "BCBS-MN: BCBS MN (MEDICARE SUPPLEMENT)",
            payorBrand: "BCBS-MN",
            payerName: "BCBS-MN",
            insuranceProductType: "Medicare Supplemental Plan",
            insuranceProductTypeId: "16",
            ediPayerId: "00720",
            governmentFundedType: null,
            isGovernmentFunded: false,
          },
        ],
      }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.insurancePackageId).toBe(37000);
    // Resolver classification rule: insurance_product_type LIKE 'Medicare%'
    // → government, regardless of the boolean flag on the source row.
    expect(out.isGovernmentFunded).toBe(true);
  });

  it("dominant-package fallback fires → result.lowConfidence=true (UI promotes confirmation card)", async () => {
    const brand = getBrand("uhc")!;
    const out = await resolvePackageFromEligibility(
      brand,
      // No EB04, no plan name → resolver leans on DOMINANT_PACKAGE_BY_EDI_EB04
      elig({ payerEdiId: "87726" }),
      {
        lookupByEdiPayerId: async () => [
          {
            insurancepackageid: 982,
            insuranceplanname: "UHC: COMMERCIAL",
            payorBrand: "UHC",
            payerName: "UHC",
            insuranceProductType: "OTHER",
            insuranceProductTypeId: "5",
            ediPayerId: "87726",
            governmentFundedType: null,
            isGovernmentFunded: false,
          },
          {
            insurancepackageid: 70322,
            insuranceplanname: "UHC: AARP MEDICARE COMPLETE",
            payorBrand: "UHC",
            payerName: "UHC",
            insuranceProductType: "Medicare PPO",
            insuranceProductTypeId: "15",
            ediPayerId: "87726",
            governmentFundedType: "Medicare Replacement/Advantage",
            isGovernmentFunded: true,
          },
        ],
      }
    );
    expect(out.confidence).toBe("id-match");
    expect(out.lowConfidence).toBe(true);
    expect(out.reason).toMatch(/dominant-package/);
  });

  it("legacy-table heuristic match (single specific planMatcher hit) is high-confidence", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "FEDERAL EMPLOYEE PROGRAM BASIC" })
    );
    expect(out.confidence).toBe("heuristic");
    expect(out.lowConfidence).toBe(false);
  });

  it("legacy-table fallback (no planMatcher hit) is flagged low-confidence", () => {
    const brand = getBrand("bcbs")!;
    const out = resolvePackageFromBrandTable(
      brand,
      elig({ planName: "Some unknown plan name" })
    );
    expect(out.confidence).toBe("fallback");
    expect(out.lowConfidence).toBe(true);
  });
});

describe("toPlanDisplay — patient-facing view-model", () => {
  it("never leaks raw insurance_package_id / EDI / EMCCODE into the view-model", () => {
    const display = toPlanDisplay({
      brandDisplayName: "UnitedHealthcare",
      resolver: {
        insurancePackageId: 70322,
        insurancePlanName: "UHC: AARP MEDICARE COMPLETE",
        isGovernmentFunded: true,
        confidence: "id-match",
        lowConfidence: false,
        reason: "edi_payer_id=87726 something internal",
      },
      planNameFrom271: "AARP MEDICARE COMPLETE PPO",
    });
    const json = JSON.stringify(display);
    expect(json).not.toMatch(/70322/);
    expect(json).not.toMatch(/87726/);
    expect(json).not.toMatch(/edi_payer_id/i);
    expect(json).not.toMatch(/EMCCODE/i);
  });

  it("classifies Medicare Advantage and skips membership", () => {
    const display = toPlanDisplay({
      brandDisplayName: "UnitedHealthcare",
      resolver: {
        insurancePackageId: 70322,
        insurancePlanName: "UHC: AARP MEDICARE COMPLETE (MA-PPO)",
        isGovernmentFunded: true,
        confidence: "id-match",
        lowConfidence: false,
        reason: "ok",
      },
      planNameFrom271: null,
    });
    expect(display.coverageCategory).toBe("medicare_advantage");
    expect(display.skipMembership).toBe(true);
    expect(display.needsConfirmation).toBe(false);
  });

  it("classifies Commercial and shows membership step when coverage is active", () => {
    const display = toPlanDisplay({
      brandDisplayName: "Blue Cross Blue Shield",
      resolver: {
        insurancePackageId: 1132,
        insurancePlanName: "BCBS-MN",
        isGovernmentFunded: false,
        confidence: "id-match",
        lowConfidence: false,
        reason: "ok",
      },
      planNameFrom271: "BCBS COMMERCIAL PPO",
      coverageStatus: "active",
    });
    expect(display.coverageCategory).toBe("commercial");
    expect(display.skipMembership).toBe(false);
  });

  it("skips membership defensively when commercial coverage isn't confirmed-active", () => {
    const display = toPlanDisplay({
      brandDisplayName: "Blue Cross Blue Shield",
      resolver: {
        insurancePackageId: 1132,
        insurancePlanName: "BCBS-MN",
        isGovernmentFunded: false,
        confidence: "id-match",
        lowConfidence: false,
        reason: "ok",
      },
      planNameFrom271: "BCBS COMMERCIAL PPO",
      coverageStatus: "unknown",
    });
    expect(display.coverageCategory).toBe("commercial");
    expect(display.skipMembership).toBe(true);
  });

  it("skips membership when the resolver couldn't pick a plan", () => {
    const display = toPlanDisplay({
      brandDisplayName: "Blue Cross Blue Shield",
      resolver: {
        insurancePackageId: null,
        insurancePlanName: null,
        isGovernmentFunded: false,
        confidence: "unresolved",
        lowConfidence: true,
        reason: "no candidates",
      },
      planNameFrom271: null,
      coverageStatus: "active",
    });
    expect(display.skipMembership).toBe(true);
    expect(display.needsConfirmation).toBe(true);
  });

  it("classifies Medicare Supplement as gov (Medicare-as-primary)", () => {
    const display = toPlanDisplay({
      brandDisplayName: "Blue Cross Blue Shield",
      resolver: {
        insurancePackageId: 37000,
        insurancePlanName: "BCBS-MN: BCBS MN (MEDICARE SUPPLEMENT)",
        isGovernmentFunded: true,
        confidence: "id-match",
        lowConfidence: false,
        reason: "ok",
      },
      planNameFrom271: null,
    });
    expect(display.coverageCategory).toBe("medicare_supplement");
    expect(display.skipMembership).toBe(true);
  });

  it("flags low-confidence resolver picks for plan-name confirmation", () => {
    const display = toPlanDisplay({
      brandDisplayName: "UnitedHealthcare",
      resolver: {
        insurancePackageId: 982,
        insurancePlanName: "UHC: COMMERCIAL",
        isGovernmentFunded: false,
        confidence: "id-match",
        lowConfidence: true,
        reason: "dominant-package fallback",
      },
      planNameFrom271: null,
    });
    expect(display.needsConfirmation).toBe(true);
  });
});
