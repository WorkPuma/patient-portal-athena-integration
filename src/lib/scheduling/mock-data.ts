/** Demo risk tier used by mock scheduling context. */
export type PatientTier = "high" | "medium" | "low";

/** Deterministic mock scheduling context for demo patients. */
export interface MockPatientContext {
  tier: PatientTier;
  awvOverdue: boolean;
  lastAwvDate: string | null;
  showBehavioralHealth: boolean;
  showMemberServices: boolean;
  cadenceWeeks: number;
  cadenceLabel: string;
}

const TIER_CONFIG: Record<PatientTier, { cadenceWeeks: number; label: string }> = {
  high: { cadenceWeeks: 4, label: "monthly" },
  medium: { cadenceWeeks: 12, label: "every 3 months" },
  low: { cadenceWeeks: 40, label: "every 8–12 months" },
};

/**
 * Deterministic pseudo-random from a seed string.
 * Returns a number between 0 and 1.
 */
function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 1000) / 1000;
}

function pickFromSeed<T>(items: T[], seed: string, offset = 0): T {
  const r = seededRandom(seed + String(offset));
  return items[Math.floor(r * items.length)];
}

/**
 * Generate mock patient context for scheduling.
 * Uses the patient ID as a deterministic seed so each demo
 * user gets consistent-but-varied presentation.
 */
export function getMockPatientContext(patientId: string): MockPatientContext {
  const tiers: PatientTier[] = ["high", "medium", "low"];
  const tier = pickFromSeed(tiers, patientId, 1);
  const config = TIER_CONFIG[tier];

  const awvOverdue = seededRandom(patientId + "awv") > 0.45;

  const daysAgo = Math.floor(seededRandom(patientId + "lastAwv") * 400) + 200;
  const lastAwvDate = new Date();
  lastAwvDate.setDate(lastAwvDate.getDate() - daysAgo);

  const showBehavioralHealth = seededRandom(patientId + "bh") > 0.3;
  const showMemberServices = seededRandom(patientId + "ms") > 0.25;

  return {
    tier,
    awvOverdue,
    lastAwvDate: lastAwvDate.toISOString().split("T")[0],
    showBehavioralHealth,
    showMemberServices,
    cadenceWeeks: config.cadenceWeeks,
    cadenceLabel: config.label,
  };
}

/** Patient-facing cadence nudge derived from mock tier context. */
export function getCadenceMessage(ctx: MockPatientContext): string {
  return `Based on your care plan, we recommend visits ${ctx.cadenceLabel}.`;
}

/** AWV overdue nudge, or null when not overdue. */
export function getAwvNudgeMessage(ctx: MockPatientContext): string | null {
  if (!ctx.awvOverdue) return null;
  const formatted = ctx.lastAwvDate
    ? new Date(ctx.lastAwvDate).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    })
    : "over a year ago";
  return `Your last Annual Wellness Visit was ${formatted}. We recommend scheduling one soon.`;
}
