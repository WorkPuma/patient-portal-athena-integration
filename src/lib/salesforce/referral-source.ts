/**
 * Wizard "How did you hear about us?" → Salesforce
 * `Lead.How_did_you_hear_about_us__c` picklist mapping.
 *
 * The wizard's REFERRAL_OPTIONS (see
 * src/components/portal/registration/RegistrationWizard.tsx) are
 * intentionally short, patient-friendly labels. Salesforce's picklist
 * uses longer, reporting-friendly labels. We keep them decoupled so
 * the patient UI can iterate without each label change being a SF
 * deploy.
 *
 * Verified against HH_UAT and HH_Prod on 2026-05-09 via:
 *   sf sobject describe --target-org UAT --sobject Lead
 *
 * SF picklist values not surfaced by the wizard (back-office only):
 *   - "Community Partner"
 */

const REFERRAL_TO_SF: Readonly<Record<string, string>> = {
  Radio: "Radio",
  Mail: "Mail (letters, postcards)",
  Google: "Search engine (Google, Bing, etc.)",
  Facebook: "Social media (Facebook, Instagram, etc.)",
  Television: "Television",
  Newspaper: "Newspaper, blog, other publication",
  Event: "Community event",
  "Word of mouth": "Recommended by a friend or colleague",
  "Doctor Referral": "Healthcare Provider",
  "Insurance Provider / Broker": "Insurance agent / broker",
  "Other / I don't know": "Other",
};

/**
 * Map a wizard referral selection to its SF picklist equivalent.
 * Returns `undefined` for unknown / empty inputs so the caller can
 * cleanly omit the field from the Lead patch instead of forcing a
 * default. Trimming + a case-insensitive lookup are tolerant of any
 * future copy edits in the wizard that don't quite line up.
 */
export function mapReferralSourceToSf(
  raw: string | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  // Fast path: exact match.
  const direct = REFERRAL_TO_SF[trimmed];
  if (direct) return direct;
  // Case-insensitive fallback.
  const lower = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(REFERRAL_TO_SF)) {
    if (key.toLowerCase() === lower) return value;
  }
  // Already an SF picklist label? Pass it through.
  const sfValues = new Set(Object.values(REFERRAL_TO_SF));
  if (sfValues.has(trimmed)) return trimmed;
  return undefined;
}

/** Exposed for tests + diagnostics. */
export const REFERRAL_SOURCE_MAP = REFERRAL_TO_SF;
