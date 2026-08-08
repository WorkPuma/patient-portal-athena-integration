/**
 * Normalize a Stedi 271 response into the patient-friendly shape the wizard
 * renders. Handles the three real-world outcomes:
 *
 *   1. Active coverage with full benefit data        → coverageStatus = "active"
 *   2. Inactive / not on file (clean 271)            → coverageStatus = "inactive"
 *   3. AAA error (CMS pre-attestation, MN DHS pre-enrollment, bad ID, etc.)
 *      → coverageStatus = "unknown" + rejectionCodes populated
 *
 * The summarizer is the only code that touches X12-shaped structures. Routes,
 * components, and the reverse resolver all consume `NormalizedEligibility`.
 */

import type { StediEligibilityResponse } from "./client";
import type { NormalizedEligibility, NormalizedOtherPayer } from "./types";

/** Convert YYYYMMDD → YYYY-MM-DD; passthrough anything else. */
function isoDate(value?: string | null): string | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function resolveCoverageStatus(
  resp: StediEligibilityResponse,
  rejectionCodes: string[]
): NormalizedEligibility["coverageStatus"] {
  const planStatusCode = resp.planStatus?.[0]?.statusCode ?? null;
  if (rejectionCodes.length > 0) return "unknown";
  if (planStatusCode === "1" || planStatusCode === "Active Coverage") {
    return "active";
  }
  if (planStatusCode === "6" || planStatusCode === "Inactive") {
    return "inactive";
  }
  return "unknown";
}

function resolvePrimaryInsuranceTypeCode(
  resp: StediEligibilityResponse
): string | null {
  const insuranceTypeTally = new Map<string, number>();
  for (const b of resp.benefitsInformation ?? []) {
    if (!b.insuranceTypeCode) continue;
    const weight = b.code === "1" ? 2 : 1;
    insuranceTypeTally.set(
      b.insuranceTypeCode,
      (insuranceTypeTally.get(b.insuranceTypeCode) ?? 0) + weight
    );
  }
  let primaryInsuranceTypeCode: string | null = null;
  let bestWeight = 0;
  for (const [code, weight] of insuranceTypeTally) {
    if (weight > bestWeight) {
      bestWeight = weight;
      primaryInsuranceTypeCode = code;
    }
  }
  return primaryInsuranceTypeCode;
}

/** Normalize a Stedi 271 into portal-friendly eligibility summary fields. */
export function summarizeEligibility(
  resp: StediEligibilityResponse
): NormalizedEligibility {
  const rejectionCodes = (resp.errors ?? [])
    .map((e) => e.code)
    .filter((c): c is string => !!c);

  const coverageStatus = resolveCoverageStatus(resp, rejectionCodes);

  const serviceTypes: string[] = [];
  for (const b of resp.benefitsInformation ?? []) {
    if (b.serviceTypeCodes) serviceTypes.push(...b.serviceTypeCodes);
  }
  for (const p of resp.planStatus ?? []) {
    if (p.serviceTypeCodes) serviceTypes.push(...p.serviceTypeCodes);
  }
  const primaryInsuranceTypeCode = resolvePrimaryInsuranceTypeCode(resp);

  const otherPayers: NormalizedOtherPayer[] = (
    resp.subscriber?.subscriberOtherPayers ?? []
  ).map((op) => ({
    name: op.name ?? null,
    ediId: op.identification?.identificationNumber ?? null,
    insuranceTypeCode: op.insuranceTypeCode ?? null,
  }));

  return {
    coverageStatus,
    payerName: resp.payer?.name ?? null,
    payerEdiId: resp.payer?.payorIdentification?.trim() || null,
    planName:
      resp.planInformation?.planName ??
      resp.planStatus?.[0]?.planDetails ??
      null,
    groupNumber: resp.planInformation?.groupNumber ?? null,
    groupName: resp.planInformation?.groupDescription ?? null,
    planBeginDate: isoDate(resp.planDateInformation?.planBegin),
    planEndDate: isoDate(resp.planDateInformation?.planEnd),
    coveredThrough: isoDate(resp.planDateInformation?.eligibilityEnd),
    activeServiceTypes: dedupe(serviceTypes),
    primaryInsuranceTypeCode,
    otherPayers,
    rejectionCodes,
  };
}

/**
 * Map an AAA reason code to a one-line patient-friendly explanation. We
 * deliberately don't surface AAA verbatim — patients don't speak X12.
 */
export function explainRejection(codes: string[]): string | null {
  if (codes.length === 0) return null;
  if (codes.includes("41")) {
    return "We're not yet enrolled with this payer for real-time eligibility. Your information is saved — our team will verify before your visit.";
  }
  if (codes.includes("45")) {
    return "Provider enrollment with this payer is in progress. We'll verify your coverage manually before your visit.";
  }
  if (codes.includes("72") || codes.includes("73")) {
    return "We couldn't match your member ID. Please double-check the digits on your insurance card and try again.";
  }
  if (codes.includes("75")) {
    return "We couldn't match your name and date of birth to this member ID. Please verify and try again.";
  }
  return "We couldn't verify your insurance right now. Your information is saved — our team will verify before your visit.";
}
