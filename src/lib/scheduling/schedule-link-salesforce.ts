/**
 * Best-effort Salesforce write-back for a schedule-link booking/reschedule.
 *
 * Creates (or matches) an `Appointment__c` tied to the patient's
 * PersonAccount so the new visit is visible in Salesforce immediately,
 * aligned with the nightly Athena→SF appointment sync (same
 * `SourceSystem__c` + `Athena_Appointment_Id__c` match keys). Never throws —
 * Salesforce being unavailable must not fail the patient's booking.
 */

import { SalesforceClient } from "@/lib/salesforce/client";
import { createRecordTolerant } from "@/lib/salesforce/field-tolerant";
import type { AthenaAppointment } from "@/lib/athena/client";
import { captureServerException } from "@/lib/capture-exception";

/** Outcome of syncing a schedule-link booking back to Salesforce. */
export interface ScheduleLinkSyncResult {
  appointmentId: string | null;
  locationId: string | null;
  physicianId: string | null;
  error: string | null;
}

/** Athena returns date as MM/DD/YYYY and starttime as HH:MM (24h). */
function parseAthenaDateTime(
  date: string | undefined,
  starttime: string | undefined
): string | undefined {
  if (!date) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  const time =
    starttime && /^\d{1,2}:\d{2}$/.test(starttime)
      ? starttime.padStart(5, "0")
      : "00:00";
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${time}:00Z`;
}

async function lookupLocationByDepartmentId(
  sf: SalesforceClient,
  athenaDepartmentId: number
): Promise<string | null> {
  try {
    const safe = String(athenaDepartmentId).replace(/[^0-9]/g, "");
    if (!safe) return null;
    const result = await sf.query<{ Id: string }>(
      `SELECT Id FROM Location WHERE department_Id__c = '${safe}' LIMIT 1`
    );
    return result.records[0]?.Id ?? null;
  } catch {
    return null;
  }
}

async function lookupContactByAthenaId(
  sf: SalesforceClient,
  athenaProviderId: number
): Promise<string | null> {
  try {
    const safe = String(athenaProviderId).replace(/[^0-9]/g, "");
    if (!safe) return null;
    const result = await sf.query<{ Id: string }>(
      `SELECT Id FROM Contact WHERE HealthCloudGA__SourceSystemId__c = '${safe}' LIMIT 1`
    );
    return result.records[0]?.Id ?? null;
  } catch {
    return null;
  }
}

/** Write booking/reschedule outcomes from schedule-link flow to Salesforce. */
export async function syncScheduleLinkBooking(args: {
  salesforceAccountId?: string;
  appointment: AthenaAppointment;
  departmentId?: number;
  providerId?: number;
  locationName?: string;
  providerName?: string;
  appointmentTypeName?: string;
  duration?: number;
  /** "Scheduled" for a fresh booking; carried on reschedule too. */
  status?: string;
}): Promise<ScheduleLinkSyncResult> {
  const result: ScheduleLinkSyncResult = {
    appointmentId: null,
    locationId: null,
    physicianId: null,
    error: null,
  };

  try {
    const sf = await SalesforceClient.fromEnvironment();
    if (!sf) {
      result.error = "salesforce_not_configured";
      return result;
    }

    const { appointment } = args;
    const providerDisplay =
      args.providerName ||
      [appointment.providerfirstname, appointment.providerlastname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      undefined;

    const athenaDeptId =
      args.departmentId ?? Number(appointment.departmentid) ?? undefined;
    const athenaProviderId =
      args.providerId ?? Number(appointment.providerid) ?? undefined;

    const [locationSfId, providerSfId] = await Promise.all([
      athenaDeptId ? lookupLocationByDepartmentId(sf, athenaDeptId) : null,
      athenaProviderId ? lookupContactByAthenaId(sf, athenaProviderId) : null,
    ]);
    result.locationId = locationSfId;
    result.physicianId = providerSfId;

    const apptData: Record<string, unknown> = {
      Athena_Appointment_Id__c: appointment.appointmentid,
      Start_Date_Time__c: parseAthenaDateTime(
        appointment.date,
        appointment.starttime
      ),
      Status__c: args.status ?? "Scheduled",
      SourceSystem__c: "AthenaOne-31254",
      Type__c: args.appointmentTypeName || appointment.appointmenttype,
      Duration__c:
        args.duration ??
        (typeof appointment.duration === "number"
          ? appointment.duration
          : undefined),
      Patient__c: args.salesforceAccountId,
      Physician__c: providerSfId ?? undefined,
      Location__c: locationSfId ?? undefined,
      Online_Provider_Name__c: providerDisplay,
      Online_Location_Name__c: args.locationName,
    };
    for (const k of Object.keys(apptData)) {
      if (apptData[k] === undefined) delete apptData[k];
    }

    const created = await createRecordTolerant(sf, apptData, {
      context: "schedule-link/appointment-create",
      sobject: "Appointment__c",
    });
    result.appointmentId = created.id;
  } catch (err) {
    result.error =
      err instanceof Error
        ? err.message.slice(0, 200)
        : String(err).slice(0, 200);
    captureServerException(err, {
      tags: {
        portal_route: "schedule-link-book",
        step: "syncScheduleLinkBooking",
        severity: "non_fatal",
      },
    });
  }

  return result;
}
