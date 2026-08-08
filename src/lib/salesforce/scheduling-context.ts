/**
 * Read-only Salesforce Account context for the standalone scheduler.
 *
 * The portal has historically been WRITE-ONLY to Salesforce. This is the
 * first reader: the schedule-link flow needs the patient's risk tier (for
 * the on-tier cadence nudge) and their MDDO / AWV follow-up eligibility (to
 * decide which follow-up suggestion cards to show).
 *
 * Field tolerance: MDDO / AWV status field API names differ across the
 * HH_UAT and HH_Prod orgs (and may lag a deploy). We query a candidate set
 * and, on an INVALID_FIELD error, drop the offending column(s) and retry —
 * mirroring the write-side `field-tolerant.ts` posture. A missing field
 * degrades to "unknown / not eligible" rather than failing the whole page.
 */

import { SalesforceClient, escapeSoql } from "@/lib/salesforce/client";
import { captureServerException } from "@/lib/capture-exception";

/** Account fields we attempt to read. Order is not significant. */
const CANDIDATE_FIELDS = [
  "Risk_Tier__c",
  "Off_Cadence_Actual__c",
  "MDDO_Visit_Status__c",
  "AWV_Status__c",
  "AWV_CMS_Source__c",
] as const;

/** Salesforce normalized status that means "go ahead and schedule this". */
const ELIGIBLE = "eligible";
/** AWV_CMS_Source__c buckets that indicate the patient can book an AWV now. */
const AWV_CMS_ELIGIBLE = new Set(["eligible now", "never had awv"]);

/** Salesforce Account fields used by the standalone schedule-link flow. */
export interface AccountSchedulingContext {
  /** Raw Risk_Tier__c (null when field absent / empty). */
  riskTier: string | null;
  /** Raw Off_Cadence_Actual__c boolean (null when field absent). */
  offCadence: boolean | null;
  /** True when the patient is eligible for an MDDO follow-up. */
  mddoEligible: boolean;
  /** True when the patient is eligible for an Annual Wellness Visit. */
  awvEligible: boolean;
  /** Fields that were dropped because the org doesn't have them. */
  missingFields: string[];
}

function extractInvalidFields(message: string): string[] {
  const fields = new Set<string>();
  const re = /'?([A-Za-z0-9_]+__c)'?/g;
  // Only treat as invalid-field when the error actually says so.
  if (!/INVALID_FIELD|No such column|invalid field/i.test(message)) return [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) fields.add(m[1]);
  return [...fields];
}

async function queryAccountWithFieldTolerance(
  sf: SalesforceClient,
  accountId: string,
  initialFields: readonly string[]
): Promise<{
  row: Record<string, unknown> | null;
  missingFields: string[];
}> {
  const safeId = escapeSoql(accountId);
  const missing: string[] = [];

  async function queryWithFields(
    fields: string[],
  ): Promise<{
    row: Record<string, unknown> | null;
    missingFields: string[];
  }> {
    if (fields.length === 0) {
      return { row: null, missingFields: missing };
    }
    const soql = `SELECT ${fields.join(", ")} FROM Account WHERE Id = '${safeId}' LIMIT 1`;
    try {
      const result = await sf.query<Record<string, unknown>>(soql);
      return { row: result.records[0] ?? {}, missingFields: missing };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bad = extractInvalidFields(message);
      const drop = bad.filter((f) => fields.includes(f));
      if (drop.length === 0) {
        throw err;
      }
      missing.push(...drop);
      return queryWithFields(fields.filter((f) => !drop.includes(f)));
    }
  }

  return queryWithFields([...initialFields]);
}

/**
 * Fetch the scheduling-relevant Account fields for `accountId`. Never
 * throws — on any unrecoverable failure it returns an all-null/false
 * context so the scheduler still renders (just without the tier nudge or
 * follow-up cards).
 */
export async function getAccountSchedulingContext(
  accountId: string
): Promise<AccountSchedulingContext> {
  const empty: AccountSchedulingContext = {
    riskTier: null,
    offCadence: null,
    mddoEligible: false,
    awvEligible: false,
    missingFields: [],
  };

  if (!accountId) return empty;

  let sf: SalesforceClient | null;
  try {
    sf = await SalesforceClient.fromEnvironment();
  } catch {
    return empty;
  }
  if (!sf) return empty;

  try {
    const { row, missingFields } = await queryAccountWithFieldTolerance(
      sf,
      accountId,
      CANDIDATE_FIELDS
    );
    if (!row) return { ...empty, missingFields };
    return buildContext(row, missingFields);
  } catch (err) {
    captureServerException(err, {
      tags: { portal_route: "schedule-link/account-context", severity: "non_fatal" },
    });
    return empty;
  }
}

function asBool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    if (/^(true|1|yes)$/i.test(v)) return true;
    if (/^(false|0|no)$/i.test(v)) return false;
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function buildContext(
  row: Record<string, unknown>,
  missing: string[]
): AccountSchedulingContext {
  const riskTier = asStr(row.Risk_Tier__c);
  const offCadence = asBool(row.Off_Cadence_Actual__c);

  const mddoStatus = (asStr(row.MDDO_Visit_Status__c) ?? "").toLowerCase();
  const awvStatus = (asStr(row.AWV_Status__c) ?? "").toLowerCase();
  const awvCmsSource = (asStr(row.AWV_CMS_Source__c) ?? "").toLowerCase();

  const mddoEligible = mddoStatus === ELIGIBLE;
  const awvEligible = awvStatus === ELIGIBLE || AWV_CMS_ELIGIBLE.has(awvCmsSource);

  return {
    riskTier,
    offCadence,
    mddoEligible,
    awvEligible,
    missingFields: missing,
  };
}
