import { SalesforceClient } from "./client";
import { captureServerMessage } from "@/lib/capture-exception";

/**
 * Best-effort, field-tolerant Salesforce writes.
 *
 * Background: the patient portal lives in front of two Salesforce orgs
 * (HH_UAT and HH_Prod). Custom fields are deployed to UAT first; preview
 * Vercel deployments still talk to Prod. A `Lead.Patient_ID__c = ...`
 * payload that works in UAT will fail with INVALID_FIELD against Prod.
 *
 * Rather than fail the whole request (and silently lose the record), we
 * parse the SF error, drop only the offending field(s), and retry once.
 * Anything we strip is reported to Sentry so missing schema gets noticed
 * during deploys instead of disappearing.
 */

export interface FieldTolerantOptions {
  /** Tag passed to Sentry breadcrumbs (e.g. "register-patient/account-create"). */
  context: string;
  /** Salesforce object name (e.g. "Lead", "Account", "Appointment__c"). */
  sobject: string;
}

/**
 * Salesforce returns errors like:
 *   "Salesforce API error: 400 - [{"message":"No such column 'Foo__c' on
 *    entity 'Lead'", "errorCode":"INVALID_FIELD", "fields":["Foo__c"]}]"
 * or:
 *   "INVALID_TYPE_ON_FIELD_IN_RECORD: Foo__c: invalid type: ..."
 *
 * Returns the set of field names safely identified as the cause, lower-cased.
 */
function extractInvalidFields(message: string): string[] {
  const fields = new Set<string>();

  const jsonMatch = message.match(/\[(\{[\s\S]*\})\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(`[${jsonMatch[1]}]`) as Array<{
        errorCode?: string;
        message?: string;
        fields?: string[];
      }>;
      for (const e of parsed) {
        const code = e.errorCode || "";
        if (
          code === "INVALID_FIELD" ||
          code === "INVALID_FIELD_FOR_INSERT_UPDATE" ||
          code === "INVALID_TYPE_ON_FIELD_IN_RECORD" ||
          code === "INVALID_VALUE"
        ) {
          for (const f of e.fields ?? []) fields.add(f);
          // Sometimes `fields` is empty and the column name lives in the
          // message: "No such column 'Foo__c' on entity 'Lead'"
          const colMatch = (e.message ?? "").match(/'([A-Za-z0-9_]+__c)'/);
          if (colMatch) fields.add(colMatch[1]);
        }
      }
    } catch {
      /* fall through to regex */
    }
  }

  // Last-resort regex over the raw message.
  const re = /'([A-Za-z0-9_]+__c)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) fields.add(m[1]);

  return [...fields];
}

function stripFields<T extends Record<string, unknown>>(
  data: T,
  drop: string[],
): T {
  const next = { ...data } as Record<string, unknown>;
  for (const f of drop) delete next[f];
  return next as T;
}

/**
 * Inspect a Salesforce error message for a DUPLICATES_DETECTED response.
 * If the rule has `allowSave: true` we can retry with the duplicate-rule
 * bypass header; if not, we surface the matched existing record id so the
 * caller can link to it instead of insisting on a new insert.
 */
function parseDuplicateError(message: string): {
  isDuplicate: boolean;
  allowSave: boolean;
  matchedId?: string;
} {
  // Pattern A: DUPLICATES_DETECTED — fired by a Duplicate Rule (e.g.
  // EMPI_Account_Duplicate_Check). Carries the matched record id inside
  // a JSON `matchResults` array, plus an `allowSave` flag we can honor
  // by sending Sforce-Duplicate-Rule-Header: allowSave=true.
  if (/"errorCode":"DUPLICATES_DETECTED"/.test(message)) {
    const allowSaveMatch = /"allowSave":\s*(true|false)/.exec(message);
    const matchedIdMatch = /"Id":"(00[0-9A-Za-z]{16,18})"/.exec(message);
    return {
      isDuplicate: true,
      allowSave: allowSaveMatch ? allowSaveMatch[1] === "true" : false,
      matchedId: matchedIdMatch?.[1],
    };
  }

  // Pattern B: DUPLICATE_VALUE — fired when a unique custom field has
  // an existing record. The header bypass DOES NOT apply here (uniqueness
  // is a database constraint, not a rule). The matched record id lives
  // in the message text, e.g.
  //   "duplicate value found: HealthCloudGA__SourceSystemId__c duplicates
  //    value on record with id: 001V40000135OKPIA2"
  if (/"errorCode":"DUPLICATE_VALUE"/.test(message)) {
    const idMatch = /record with id:\s*(00[0-9A-Za-z]{16,18})/.exec(message);
    return {
      isDuplicate: true,
      allowSave: false,
      matchedId: idMatch?.[1],
    };
  }

  return { isDuplicate: false, allowSave: false };
}

/**
 * Custom fields whose absence in a Salesforce org breaks downstream
 * portal flows. Dropping any of these silently (the way the tolerant
 * retry would, on `INVALID_FIELD`) leaves a Lead/Account behind that
 * later queries can't find — the booking-step Lead-patch SOQL keys off
 * Patient_ID__c / Matched_Account__c, and the eligibility verifier
 * filters on Eligibility_Status__c. We still let the create succeed
 * (the field-tolerant pattern exists precisely because UAT/Prod orgs
 * sometimes lag on deploying these fields), but escalate to Sentry
 * `error` so the gap surfaces in dashboards / pages.
 *
 * Add new fields here when their absence would silently break a
 * downstream reader — i.e. anything that the verifier, a SF report, a
 * back-office process, or a follow-up route SOQLs on directly.
 */
const CRITICAL_LEAD_FIELDS = new Set<string>([
  "Patient_ID__c",
  "Eligibility_Status__c",
  "Matched_Account__c",
  "Online_Registration_Appointment__c",
  "Online_Registration_Started__c",
]);
const CRITICAL_ACCOUNT_FIELDS = new Set<string>([
  "Patient_ID__c",
  "SourceSystemIdentifier",
  "Primary_Insurance_Plan__c",
]);
const CRITICAL_APPOINTMENT_FIELDS = new Set<string>([
  "Athena_Appointment_Id__c",
  "Account__pc",
  "Account__c",
]);

function criticalFieldsForSobject(sobject: string): Set<string> {
  switch (sobject) {
    case "Lead":
      return CRITICAL_LEAD_FIELDS;
    case "Account":
      return CRITICAL_ACCOUNT_FIELDS;
    case "Appointment__c":
      return CRITICAL_APPOINTMENT_FIELDS;
    default:
      return new Set();
  }
}

/**
 * Create a Salesforce record, stripping unknown fields on INVALID_FIELD errors.
 */
async function createRecordWithInvalidFieldStripping(
  client: SalesforceClient,
  data: Record<string, unknown>,
  opts: FieldTolerantOptions,
): Promise<{ id: string }> {
  const attempt = (
    payload: Record<string, unknown>,
    allowDuplicateRule: boolean,
  ) => client.createRecord(opts.sobject, payload, { allowDuplicateRule });

  const strippedSoFar: string[] = [];
  const criticalFields = criticalFieldsForSobject(opts.sobject);

  async function tryCreate(
    attemptNum: number,
    workingData: Record<string, unknown>,
  ): Promise<{ id: string }> {
    if (attemptNum >= 8) {
      captureServerMessage(
        `[SF:${opts.context}] gave up after stripping ${strippedSoFar.length} fields: ${strippedSoFar.join(", ")}`,
        { level: "error" },
      );
      return attempt(workingData, true);
    }

    try {
      return await attempt(workingData, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bad = extractInvalidFields(message);
      if (bad.length > 0) {
        const droppedCritical = bad.filter((f) => criticalFields.has(f));
        if (droppedCritical.length > 0) {
          captureServerMessage(
            `[SF:${opts.context}] CRITICAL field(s) missing from ${opts.sobject} schema, dropping anyway: ${droppedCritical.join(", ")}`,
            {
              level: "error",
              tags: {
                portal_critical_sf_field_missing: "true",
                sobject: opts.sobject,
                context: opts.context,
              },
              extra: {
                droppedCritical,
                allStripped: [...strippedSoFar, ...bad],
              },
            },
          );
        }
        strippedSoFar.push(...bad);
        return tryCreate(attemptNum + 1, stripFields(workingData, bad));
      }

      const dup = parseDuplicateError(message);
      if (dup.isDuplicate) {
        if (dup.matchedId) {
          captureServerMessage(
            `[SF:${opts.context}] duplicate detected; reusing matched record ${dup.matchedId}` +
            (strippedSoFar.length
              ? ` (after stripping ${strippedSoFar.join(", ")})`
              : ""),
            { level: "warning" },
          );
          return { id: dup.matchedId };
        }
        if (dup.allowSave) {
          captureServerMessage(
            `[SF:${opts.context}] duplicate rule fired without matched id; retrying with allowSave=true`,
            { level: "warning" },
          );
          try {
            return await attempt(workingData, true);
          } catch (retryErr) {
            const retryMessage =
              retryErr instanceof Error
                ? retryErr.message
                : String(retryErr);
            const retryDup = parseDuplicateError(retryMessage);
            if (retryDup.matchedId) {
              return { id: retryDup.matchedId };
            }
            throw retryErr;
          }
        }
      }

      throw err;
    }
  }

  return tryCreate(0, { ...data });
}

/**
 * Create a Salesforce record, stripping unknown fields on INVALID_FIELD errors.
 * @param client - Authenticated Salesforce client
 * @param data - Field payload
 * @param opts - SObject name and logging context
 */
export async function createRecordTolerant(
  client: SalesforceClient,
  data: Record<string, unknown>,
  opts: FieldTolerantOptions,
): Promise<{ id: string }> {
  return createRecordWithInvalidFieldStripping(client, data, opts);
}

/**
 * Update a Salesforce record, stripping unknown fields on INVALID_FIELD errors.
 * @param client - Authenticated Salesforce client
 * @param recordId - Record to update
 * @param data - Field payload
 * @param opts - SObject name and logging context
 */
export async function updateRecordTolerant(
  client: SalesforceClient,
  recordId: string,
  data: Record<string, unknown>,
  opts: FieldTolerantOptions,
): Promise<void> {
  try {
    await client.updateRecord(opts.sobject, recordId, data);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const bad = extractInvalidFields(message);
    if (bad.length === 0) throw err;

    const criticalFields = criticalFieldsForSobject(opts.sobject);
    const droppedCritical = bad.filter((f) => criticalFields.has(f));
    if (droppedCritical.length > 0) {
      captureServerMessage(
        `[SF:${opts.context}] CRITICAL field(s) missing on ${opts.sobject} update, dropping anyway: ${droppedCritical.join(", ")}`,
        {
          level: "error",
          tags: {
            portal_critical_sf_field_missing: "true",
            sobject: opts.sobject,
            context: opts.context,
            operation: "update",
          },
          extra: { droppedCritical, allStripped: bad, recordId },
        },
      );
    } else {
      captureServerMessage(
        `[SF:${opts.context}] retrying update after stripping unknown fields: ${bad.join(", ")}`,
        { level: "warning" },
      );
    }
    const stripped = stripFields(data, bad);
    await client.updateRecord(opts.sobject, recordId, stripped);
  }
}
