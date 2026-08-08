import { describe, expect, it } from "vitest";
import {
  TIER_VISITS_PER_YEAR,
  getTierCadenceMessage,
  getTierPolicy,
  normalizeRiskTier,
} from "./tier-policy";

describe("normalizeRiskTier", () => {
  it("maps Highly Complex variants", () => {
    expect(normalizeRiskTier("Highly Complex")).toBe("highly_complex");
    expect(normalizeRiskTier("highly complex")).toBe("highly_complex");
  });

  it("maps high-risk / rising variants to high_rising", () => {
    expect(normalizeRiskTier("OM - High Risk/Rising")).toBe("high_rising");
    expect(normalizeRiskTier("High Risk")).toBe("high_rising");
    expect(normalizeRiskTier("High Risk/Rising")).toBe("high_rising");
  });

  it("maps plain Rising", () => {
    expect(normalizeRiskTier("Rising")).toBe("rising");
  });

  it("maps Low variants", () => {
    expect(normalizeRiskTier("Low")).toBe("low");
    expect(normalizeRiskTier("Low Risk")).toBe("low");
  });

  it("maps empty / unknown / No Tier to no_tier", () => {
    expect(normalizeRiskTier(null)).toBe("no_tier");
    expect(normalizeRiskTier(undefined)).toBe("no_tier");
    expect(normalizeRiskTier("")).toBe("no_tier");
    expect(normalizeRiskTier("No Tier")).toBe("no_tier");
    expect(normalizeRiskTier("something else")).toBe("no_tier");
  });
});

describe("getTierPolicy", () => {
  it("resolves visits/year from the policy table", () => {
    expect(getTierPolicy("Highly Complex").visitsPerYear).toBe(
      TIER_VISITS_PER_YEAR.highly_complex
    );
    expect(getTierPolicy("High Risk").visitsPerYear).toBe(
      TIER_VISITS_PER_YEAR.high_rising
    );
    expect(getTierPolicy("Rising").visitsPerYear).toBe(
      TIER_VISITS_PER_YEAR.rising
    );
    expect(getTierPolicy("Low").visitsPerYear).toBe(TIER_VISITS_PER_YEAR.low);
    expect(getTierPolicy(null).visitsPerYear).toBe(TIER_VISITS_PER_YEAR.no_tier);
  });

  it("higher acuity tiers recommend more visits", () => {
    expect(getTierPolicy("Highly Complex").visitsPerYear).toBeGreaterThan(
      getTierPolicy("Low").visitsPerYear
    );
  });

  it("produces a friendly cadence label", () => {
    // Low = 2/yr → about every 6 months.
    expect(getTierPolicy("Low").cadenceLabel).toContain("every 6 months");
  });
});

describe("getTierCadenceMessage", () => {
  it("leads with a due nudge when off cadence", () => {
    const msg = getTierCadenceMessage(getTierPolicy("Rising"), true);
    expect(msg.toLowerCase()).toContain("due");
  });

  it("reinforces cadence when on track", () => {
    const msg = getTierCadenceMessage(getTierPolicy("Rising"), false);
    expect(msg.toLowerCase()).not.toContain("you're due");
    expect(msg).toContain("3 visits a year");
  });
});
