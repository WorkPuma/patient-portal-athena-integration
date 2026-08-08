// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  summarizeEligibility,
  explainRejection,
} from "./eligibility-summary";
import type { StediEligibilityResponse } from "./client";

function baseResp(
  overrides: Partial<StediEligibilityResponse> = {}
): StediEligibilityResponse {
  return {
    payer: { name: "AETNA INC" },
    planStatus: [{ statusCode: "1", planDetails: "PPO" }],
    benefitsInformation: [],
    planInformation: { planName: "Allina Health Aetna Medicare Enhanced (PPO)" },
    planDateInformation: {
      planBegin: "20250101",
      planEnd: "20251231",
      eligibilityEnd: "20251231",
    },
    subscriber: {},
    ...overrides,
  } as StediEligibilityResponse;
}

describe("summarizeEligibility", () => {
  it("flags coverageStatus 'active' for status code 1", () => {
    const out = summarizeEligibility(baseResp());
    expect(out.coverageStatus).toBe("active");
    expect(out.payerName).toBe("AETNA INC");
    expect(out.planName).toContain("Aetna Medicare");
    expect(out.planBeginDate).toBe("2025-01-01");
    expect(out.planEndDate).toBe("2025-12-31");
    expect(out.coveredThrough).toBe("2025-12-31");
    expect(out.rejectionCodes).toEqual([]);
  });

  it("recognizes 'Active Coverage' string status", () => {
    const out = summarizeEligibility(
      baseResp({ planStatus: [{ statusCode: "Active Coverage" }] })
    );
    expect(out.coverageStatus).toBe("active");
  });

  it("flags coverageStatus 'inactive' for status code 6", () => {
    const out = summarizeEligibility(
      baseResp({ planStatus: [{ statusCode: "6" }] })
    );
    expect(out.coverageStatus).toBe("inactive");
  });

  it("flags coverageStatus 'unknown' for any other status code", () => {
    const out = summarizeEligibility(
      baseResp({ planStatus: [{ statusCode: "Z" }] })
    );
    expect(out.coverageStatus).toBe("unknown");
  });

  it("flags 'unknown' and surfaces AAA codes when errors present", () => {
    const out = summarizeEligibility(
      baseResp({
        errors: [{ code: "41" }, { code: "72" }],
      } as Partial<StediEligibilityResponse>)
    );
    expect(out.coverageStatus).toBe("unknown");
    expect(out.rejectionCodes).toEqual(["41", "72"]);
  });

  it("dedupes service type codes from benefits + planStatus", () => {
    const out = summarizeEligibility(
      baseResp({
        benefitsInformation: [
          { serviceTypeCodes: ["30", "MH"] },
          { serviceTypeCodes: ["30"] },
        ],
        planStatus: [{ statusCode: "1", serviceTypeCodes: ["MH"] }],
      } as Partial<StediEligibilityResponse>)
    );
    expect(out.activeServiceTypes.sort()).toEqual(["30", "MH"]);
  });

  it("normalizes other payers from Loop 2120C", () => {
    const out = summarizeEligibility(
      baseResp({
        subscriber: {
          subscriberOtherPayers: [
            {
              name: "BCBS MN",
              identification: { identificationNumber: "00720" },
              insuranceTypeCode: "MA",
            },
          ],
        },
      } as Partial<StediEligibilityResponse>)
    );
    expect(out.otherPayers).toEqual([
      { name: "BCBS MN", ediId: "00720", insuranceTypeCode: "MA" },
    ]);
  });

  it("passes through ISO dates already in YYYY-MM-DD form", () => {
    const out = summarizeEligibility(
      baseResp({
        planDateInformation: { planBegin: "2025-01-01" },
      })
    );
    expect(out.planBeginDate).toBe("2025-01-01");
  });
});

describe("explainRejection", () => {
  it("returns null when no codes are present", () => {
    expect(explainRejection([])).toBeNull();
  });

  it("recognizes 41 (not enrolled)", () => {
    expect(explainRejection(["41"])).toMatch(/not yet enrolled/i);
  });

  it("recognizes 45 (provider enrollment in progress)", () => {
    expect(explainRejection(["45"])).toMatch(/enrollment with this payer/i);
  });

  it("recognizes 72 / 73 (member id mismatch)", () => {
    expect(explainRejection(["72"])).toMatch(/member ID/i);
    expect(explainRejection(["73"])).toMatch(/member ID/i);
  });

  it("recognizes 75 (name/DOB mismatch)", () => {
    expect(explainRejection(["75"])).toMatch(/name and date of birth/i);
  });

  it("returns a generic message for unknown codes", () => {
    expect(explainRejection(["99"])).toMatch(/couldn't verify/i);
  });
});
