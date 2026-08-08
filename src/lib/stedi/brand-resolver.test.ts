// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  PORTAL_PAYER_BRANDS,
  listPortalPayerBrands,
  getBrand,
  resolveBrandForStedi,
  pickRetryBrandFromOtherPayer,
} from "./brand-resolver";

describe("PORTAL_PAYER_BRANDS catalog", () => {
  it("includes the 13 curated brands (11 real + TRICARE for Life + handoff)", () => {
    expect(PORTAL_PAYER_BRANDS).toHaveLength(13);
  });

  it("has unique brand ids", () => {
    const ids = PORTAL_PAYER_BRANDS.map((b) => b.brandId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags Medicare and Medicaid as enrollment_pending", () => {
    expect(getBrand("medicare")?.enrollmentPending).toBe(true);
    expect(getBrand("medicaid-mn")?.enrollmentPending).toBe(true);
  });

  it("marks the 'other' brand for guided handoff", () => {
    expect(getBrand("other")?.guidedHandoff).toBe(true);
  });
});

describe("listPortalPayerBrands", () => {
  it("returns brands sorted by orderIndex ascending", () => {
    const list = listPortalPayerBrands();
    for (let i = 1; i < list.length; i++) {
      expect(list[i].orderIndex).toBeGreaterThanOrEqual(list[i - 1].orderIndex);
    }
  });

  it("does not mutate the source catalog", () => {
    const before = PORTAL_PAYER_BRANDS.map((b) => b.brandId).join(",");
    listPortalPayerBrands().reverse();
    const after = PORTAL_PAYER_BRANDS.map((b) => b.brandId).join(",");
    expect(after).toBe(before);
  });
});

describe("getBrand", () => {
  it("returns the brand for a known id", () => {
    expect(getBrand("uhc")?.displayName).toBe("UnitedHealthcare");
  });

  it("returns null for an unknown id", () => {
    expect(getBrand("not-a-brand")).toBeNull();
  });
});

describe("resolveBrandForStedi", () => {
  it("returns default + alts in order for Medicare", () => {
    const result = resolveBrandForStedi("medicare");
    expect(result?.brand.brandId).toBe("medicare");
    expect(result?.stediPayerIds[0]).toBe("CMS");
    expect(result?.stediPayerIds.length).toBeGreaterThan(1);
  });

  it("returns just the default when no alts are configured", () => {
    const result = resolveBrandForStedi("aetna");
    expect(result?.stediPayerIds).toEqual(["60054"]);
  });

  it("returns null for the guided-handoff 'other' brand", () => {
    expect(resolveBrandForStedi("other")).toBeNull();
  });

  it("returns null for unknown brand ids", () => {
    expect(resolveBrandForStedi("nope")).toBeNull();
  });
});

describe("pickRetryBrandFromOtherPayer", () => {
  it("returns null when given a null name", () => {
    expect(pickRetryBrandFromOtherPayer(null)).toBeNull();
  });

  it("maps United variants to UHC", () => {
    expect(pickRetryBrandFromOtherPayer("UNITED HEALTHCARE")?.brandId).toBe(
      "uhc"
    );
  });

  it("maps BCBS variants to bcbs", () => {
    expect(pickRetryBrandFromOtherPayer("Blue Cross")?.brandId).toBe("bcbs");
    expect(pickRetryBrandFromOtherPayer("BCBS-MN")?.brandId).toBe("bcbs");
  });

  it("maps HealthPartners spellings to healthpartners", () => {
    expect(pickRetryBrandFromOtherPayer("HealthPartners Inc")?.brandId).toBe(
      "healthpartners"
    );
    expect(
      pickRetryBrandFromOtherPayer("Health Partners of MN")?.brandId
    ).toBe("healthpartners");
  });

  it("maps Aetna, Humana, UCare, Medica", () => {
    expect(pickRetryBrandFromOtherPayer("AETNA INC")?.brandId).toBe("aetna");
    expect(pickRetryBrandFromOtherPayer("Humana")?.brandId).toBe("humana");
    expect(pickRetryBrandFromOtherPayer("UCARE MN")?.brandId).toBe("ucare");
    expect(pickRetryBrandFromOtherPayer("MEDICA HEALTH")?.brandId).toBe(
      "medica"
    );
  });

  it("returns null for unknown carrier names", () => {
    expect(pickRetryBrandFromOtherPayer("Some Tiny Co-op")).toBeNull();
  });
});
