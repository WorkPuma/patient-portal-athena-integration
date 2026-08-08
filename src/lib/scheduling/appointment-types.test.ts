import { describe, expect, it } from "vitest";
import {
  REGISTRATION_INITIAL_VISIT_TYPE_IDS,
  getRegistrationInitialVisitTypeId,
  getRegistrationVariantFromInsurance,
} from "./appointment-types";

describe("getRegistrationVariantFromInsurance", () => {
  it("returns 'standard' when insurance is missing", () => {
    expect(getRegistrationVariantFromInsurance(null)).toBe("standard");
    expect(getRegistrationVariantFromInsurance(undefined)).toBe("standard");
    expect(getRegistrationVariantFromInsurance({})).toBe("standard");
  });

  it("returns 'standard' for government-funded coverage (Medicare/Medicaid/TRICARE/VA)", () => {
    expect(
      getRegistrationVariantFromInsurance({ isGovernmentFunded: true })
    ).toBe("standard");
  });

  it("returns 'mbr' for commercial / membership-eligible coverage", () => {
    expect(
      getRegistrationVariantFromInsurance({ isGovernmentFunded: false })
    ).toBe("mbr");
  });
});

describe("getRegistrationInitialVisitTypeId", () => {
  it("maps standard + in_person -> 47 (90-min Initial Visit)", () => {
    expect(getRegistrationInitialVisitTypeId("in_person", "standard")).toBe(47);
  });

  it("maps mbr + in_person -> 461 (60-min MBR Initial Visit)", () => {
    expect(getRegistrationInitialVisitTypeId("in_person", "mbr")).toBe(461);
  });

  it("maps any variant + telehealth -> 223 (Telehlth Any 90 Initial)", () => {
    expect(getRegistrationInitialVisitTypeId("telehealth", "standard")).toBe(
      223
    );
    expect(getRegistrationInitialVisitTypeId("telehealth", "mbr")).toBe(223);
  });

  it("defaults to 'standard' when variant is omitted", () => {
    expect(getRegistrationInitialVisitTypeId("in_person")).toBe(47);
    expect(getRegistrationInitialVisitTypeId("telehealth")).toBe(223);
  });
});

describe("REGISTRATION_INITIAL_VISIT_TYPE_IDS allowlist", () => {
  it("accepts every typeid the helper can return", () => {
    for (const modality of ["in_person", "telehealth"] as const) {
      for (const variant of ["standard", "mbr"] as const) {
        const id = getRegistrationInitialVisitTypeId(modality, variant);
        expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(id)).toBe(true);
      }
    }
  });

  it("keeps the legacy 142 ('Any 90 Initial') accepted for rolling-deploy compat", () => {
    expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(142)).toBe(true);
  });

  it("rejects established-patient appointment types (49, 50, 64, 461 telehealth, etc.)", () => {
    expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(49)).toBe(false); // Routine
    expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(50)).toBe(false); // Urgent
    expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(64)).toBe(false); // Any 40
    expect(REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(48)).toBe(false); // AWV
  });
});
