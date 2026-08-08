/**
 * Background Medicare AWV enrichment for the patient portal registration flow.
 *
 * Triggered after `/api/portal/register/eligibility` succeeds for a Medicare
 * or Medicare Advantage brand. Runs as a fire-and-forget background task
 * (Next.js `after()`) so the user-visible eligibility step is never slowed
 * down by the chained CMS lookups (~5s for MBI Lookup + ~1.5s for CMS BZ).
 *
 * Flow:
 *   1. If brand is `medicare`, the patient supplied an MBI directly — skip
 *      the lookup and use it as-is.
 *   2. If brand is an MA carrier (UHC, BCBS, UCare, Medica, HealthPartners,
 *      Humana), run a Stedi MBI Lookup (no SSN) against CMS using
 *      first/last/DOB/state.
 *   3. Run a CMS BZ 270 with the MBI; parse with `parseAwvFromStediResponse`.
 *   4. Stamp `Account.Last_AWV_Date__c`, `Account.MBI__c`,
 *      `Account.AWV_CMS_Source__c`, `Account.AWV_CMS_Last_Checked__c`,
 *      and `Lead.MBI__c` (when leadId is known).
 *
 * Soft-fail semantics: every external call and every Salesforce write is
 * wrapped in try/catch + Sentry. Failures never propagate. The patient
 * never knows this ran.
 *
 * Behind ENABLE_MEDICARE_AWV_LOOKUP=1; defaults off.
 */

import "server-only";
import { captureServerException } from "@/lib/capture-exception";
import {
  runEligibilityCheck,
  runMbiLookupNoSsn,
  StediApiError,
} from "@/lib/stedi/client";
import { parseAwvFromStediResponse, type AwvParseResult } from "@/lib/stedi/awv";
import { SalesforceClient } from "@/lib/salesforce/client";
import { updateRecordTolerant } from "@/lib/salesforce/field-tolerant";

/** Brands for which it's worth asking CMS about AWV cadence. */
const AWV_ELIGIBLE_BRANDS = new Set([
  "medicare",
  "uhc",
  "bcbs",
  "ucare",
  "medica",
  "healthpartners",
  "humana",
]);

export function isAwvLookupEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ENABLE_MEDICARE_AWV_LOOKUP ?? "");
}

export function isAwvEligibleBrand(brandId: string): boolean {
  return AWV_ELIGIBLE_BRANDS.has(brandId);
}

export interface AwvLookupArgs {
  brandId: string;
  /** MBI when the patient gave one directly (Medicare brand); otherwise null. */
  knownMbi: string | null;
  patient: {
    firstName: string;
    lastName: string;
    /** YYYYMMDD per X12. */
    dateOfBirth: string;
    /** US state two-letter, used for the no-SSN MBI lookup. */
    state: string;
  };
  salesforceLeadId: string | null;
  salesforceAccountId: string | null;
}

export interface AwvLookupOutcome {
  ranLookup: boolean;
  mbi: string | null;
  awv: AwvParseResult | null;
  /** Audit-friendly free text describing why we stopped (success or otherwise). */
  reason: string;
}

/**
 * Resolve the patient's MBI, query CMS BZ, parse the AWV, stamp Salesforce.
 * Always resolves; never throws. Returns an outcome object useful for
 * logging / e2e assertion (the registration route doesn't read it).
 */
export async function runAwvEnrichment(
  args: AwvLookupArgs
): Promise<AwvLookupOutcome> {
  const { brandId, knownMbi, patient, salesforceLeadId, salesforceAccountId } =
    args;

  if (!isAwvLookupEnabled()) {
    return { ranLookup: false, mbi: null, awv: null, reason: "flag_disabled" };
  }
  if (!isAwvEligibleBrand(brandId)) {
    return { ranLookup: false, mbi: null, awv: null, reason: "brand_skipped" };
  }

  // Step 1: resolve MBI.
  let mbi = knownMbi;
  if (!mbi) {
    try {
      const lookup = await runMbiLookupNoSsn({
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        state: patient.state,
      });
      const aaa = (lookup.errors ?? []).map((e) => e.code);
      if (aaa.length) {
        return {
          ranLookup: true,
          mbi: null,
          awv: null,
          reason: `mbi_lookup_aaa:${aaa.join(",")}`,
        };
      }
      mbi = lookup.subscriber?.memberId ?? null;
      if (!mbi) {
        return {
          ranLookup: true,
          mbi: null,
          awv: null,
          reason: "mbi_lookup_returned_no_memberId",
        };
      }
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          step: "awv-mbi-lookup",
          severity: "non_fatal",
        },
      });
      return {
        ranLookup: true,
        mbi: null,
        awv: null,
        reason:
          err instanceof StediApiError
            ? `mbi_lookup_http_${err.statusCode}`
            : "mbi_lookup_threw",
      };
    }
  }

  // Step 2: CMS BZ 270 with the resolved MBI.
  let cmsResp;
  try {
    cmsResp = await runEligibilityCheck({
      tradingPartnerServiceId: "CMS",
      serviceTypeCodes: ["BZ"],
      subscriber: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        memberId: mbi,
      },
    });
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-eligibility",
        step: "awv-cms-bz",
        severity: "non_fatal",
      },
    });
    return {
      ranLookup: true,
      mbi,
      awv: null,
      reason:
        err instanceof StediApiError
          ? `cms_bz_http_${err.statusCode}`
          : "cms_bz_threw",
    };
  }

  const aaa = (cmsResp.errors ?? []).map((e) => e.code);
  if (aaa.length) {
    return {
      ranLookup: true,
      mbi,
      awv: null,
      reason: `cms_bz_aaa:${aaa.join(",")}`,
    };
  }

  const awv = parseAwvFromStediResponse(cmsResp);

  // Step 3: stamp Salesforce. Each write is independent — one failure
  // doesn't roll back the others.
  await stampSalesforce({
    salesforceLeadId,
    salesforceAccountId,
    mbi,
    awv,
  });

  return { ranLookup: true, mbi, awv, reason: "ok" };
}

async function stampSalesforce(args: {
  salesforceLeadId: string | null;
  salesforceAccountId: string | null;
  mbi: string;
  awv: AwvParseResult;
}): Promise<void> {
  const { salesforceLeadId, salesforceAccountId, mbi, awv } = args;
  if (!salesforceLeadId && !salesforceAccountId) return;

  const sf = await SalesforceClient.fromEnvironment();
  if (!sf) return;

  const nowIso = new Date().toISOString();

  if (salesforceAccountId) {
    const accountFields: Record<string, unknown> = {
      MBI__c: mbi,
      AWV_CMS_Source__c: awv.bucket,
      AWV_CMS_Last_Checked__c: nowIso,
    };
    // Only stamp Last_AWV_Date__c when CMS gave us a real prior-AWV date —
    // never overwrite a real value with null. This field is also written by
    // AppointmentTriggerHandler when an in-system AWV completes; our value
    // is the older of the two truths (CMS knows about visits done elsewhere).
    if (awv.lastAwvDate) {
      accountFields.Last_AWV_Date__c = awv.lastAwvDate;
    }
    try {
      await updateRecordTolerant(sf, salesforceAccountId, accountFields, {
        context: "register-eligibility/awv-account",
        sobject: "Account",
      });
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          step: "awv-stamp-account",
          severity: "non_fatal",
        },
      });
    }
  }

  if (salesforceLeadId) {
    try {
      await updateRecordTolerant(
        sf,
        salesforceLeadId,
        { MBI__c: mbi },
        {
          context: "register-eligibility/awv-lead",
          sobject: "Lead",
        }
      );
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          step: "awv-stamp-lead",
          severity: "non_fatal",
        },
      });
    }
  }
}
