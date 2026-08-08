/**
 * POST /api/portal/register/appointments/book
 *
 * Book an open appointment slot for the in-progress registrant. regToken-authed.
 *
 * Resiliency:
 *   - Surfaces 409 from Athena as "This time is no longer available" so the UI
 *     can prompt the user to pick a different slot.
 *   - Idempotent: a double-clicked Book button returns the prior result instead
 *     of re-booking (or wasting an Athena 4xx).
 */

import { NextRequest, NextResponse } from "next/server";
import { captureServerException } from "@/lib/capture-exception";
import {
  AthenaApiError,
  bookAppointment,
  setPatientPrimaryAssignment,
} from "@/lib/athena/client";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import {
  withPortalErrors,
  parseJsonBody,
  idempotencyGet,
  idempotencySet,
} from "@/lib/portal/api";
import { recordFollowup, isPendingPatientId } from "@/lib/portal/followup";
import { REGISTRATION_INITIAL_VISIT_TYPE_IDS } from "@/lib/scheduling/appointment-types";
import { SalesforceClient, escapeSoql } from "@/lib/salesforce/client";
import {
  createRecordTolerant,
  updateRecordTolerant,
} from "@/lib/salesforce/field-tolerant";
import type { AthenaAppointment } from "@/lib/athena/client";
import type { VerifiedRegistrationToken } from "@/lib/auth/registration-token";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";

interface BookPayload {
  appointmentId: number;
  appointmenttypeid?: number;
  reasonid?: number;
  bookingnote?: string;
  /** Athena department id for the booked clinic — resolved to a Location lookup. */
  departmentId?: number;
  /** Athena providerid for the booked clinician — resolved to a Contact lookup. */
  providerId?: number;
  /** Patient-facing location name (fallback for Online_Location_Name__c). */
  locationName?: string;
  /** Provider display name (fallback for Online_Provider_Name__c). */
  providerName?: string;
  /** Athena appointment type name (e.g. "Initial Visit"). */
  appointmentTypeName?: string;
  /** Athena slot duration in minutes. */
  duration?: number;
}

/**
 * Best-effort Salesforce sync for a successful Athena booking:
 *
 *   1. Create Appointment__c with Athena_Appointment_Id__c (so Athena Pro
 *      inbound sync, when live, matches by source-system id) and
 *      Patient__c lookup → the PersonAccount we created at /register/patient.
 *   2. PATCH the Lead created at /register/eligibility with
 *      Online_Registration_Appointment__c → the new Appointment.
 *
 * The Lead is located by SOQL on Patient_ID__c (Athena patient id) since
 * we don't carry the leadId through the regToken claims (would require a
 * re-mint at the eligibility step). Falls back to the regToken's
 * salesforceLeadId when present.
 *
 * Never throws — Salesforce being down must not affect the booking.
 */
interface BookingSalesforceResult {
  /** Appointment__c id created (or matched) in Salesforce. */
  appointmentId: string | null;
  /** Lead id we patched with Online_Registration_Appointment__c. */
  leadId: string | null;
  /** Resolved Salesforce Location lookup id (if found). */
  locationId: string | null;
  /** Resolved Salesforce Contact lookup id for the provider (if found). */
  physicianId: string | null;
  /** Last-step error message, if any. */
  error: string | null;
}

async function syncBookingToSalesforce(args: {
  session: VerifiedRegistrationToken;
  appointment: AthenaAppointment;
  departmentId?: number;
  providerId?: number;
  locationName?: string;
  providerName?: string;
  appointmentTypeName?: string;
  duration?: number;
}): Promise<BookingSalesforceResult> {
  const {
    session,
    appointment,
    departmentId,
    providerId,
    locationName,
    providerName,
    appointmentTypeName,
    duration,
  } = args;
  const sfResult: BookingSalesforceResult = {
    appointmentId: null,
    leadId: null,
    locationId: null,
    physicianId: null,
    error: null,
  };
  try {
    const sf = await SalesforceClient.fromEnvironment();
    if (!sf) {
      sfResult.error = "salesforce_not_configured";
      return sfResult;
    }

    const providerDisplay =
      providerName ||
      [appointment.providerfirstname, appointment.providerlastname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      undefined;

    const apptDate = parseAthenaDateTime(
      appointment.date,
      appointment.starttime,
    );

    // Resolve Lookup ids in parallel — Athena department id → Location,
    // Athena provider id → Contact (matched on the same source-system id
    // the nightly Athena→SF sync uses). Failure on either side falls
    // through to the free-text "Online_*_Name__c" fallback fields.
    const athenaDeptId =
      departmentId ?? Number(appointment.departmentid) ?? undefined;
    const athenaProviderId =
      providerId ?? Number(appointment.providerid) ?? undefined;
    const [locationSfId, providerSfId] = await Promise.all([
      athenaDeptId ? lookupLocationByDepartmentId(sf, athenaDeptId) : null,
      athenaProviderId ? lookupContactByAthenaId(sf, athenaProviderId) : null,
    ]);
    sfResult.locationId = locationSfId;
    sfResult.physicianId = providerSfId;

    const apptData: Record<string, unknown> = {
      Athena_Appointment_Id__c: appointment.appointmentid,
      Start_Date_Time__c: apptDate,
      Status__c: "Scheduled",
      // Aligned with the Prefect Athena→SF appointment sync so this
      // record can be upserted by the nightly job without conflict.
      SourceSystem__c: "AthenaOne-31254",
      Type__c: appointmentTypeName || appointment.appointmenttype,
      Duration__c:
        duration ?? (typeof appointment.duration === "number" ? appointment.duration : undefined),
      // Lookups (preferred — these are what the nightly sync populates).
      Patient__c: session.salesforceAccountId,
      Physician__c: providerSfId ?? undefined,
      Location__c: locationSfId ?? undefined,
      // Free-text fallbacks for record visibility when the lookups don't
      // resolve (e.g. provider/Contact not yet synced).
      Online_Provider_Name__c: providerDisplay,
      Online_Location_Name__c: locationName,
    };
    for (const k of Object.keys(apptData)) {
      if (apptData[k] === undefined) delete apptData[k];
    }

    const apptCreated = await createRecordTolerant(sf, apptData, {
      context: "register-book/appointment-create",
      sobject: "Appointment__c",
    });
    sfResult.appointmentId = apptCreated.id;

    // Locate the Lead by Athena patient id (preferred) or by Account
    // lookup (fallback if the eligibility step's Lead create dropped
    // Patient_ID__c via field-tolerant retry).
    let leadId: string | undefined;
    try {
      const byPatient = await sf.query<{ Id: string }>(
        `SELECT Id FROM Lead WHERE Patient_ID__c = '${escapeSoql(
          session.athenaPatientId,
        )}' ORDER BY CreatedDate DESC LIMIT 1`,
      );
      leadId = byPatient.records[0]?.Id;
    } catch {
      /* Patient_ID__c may not exist on this org yet — fall through. */
    }
    if (!leadId && session.salesforceAccountId) {
      try {
        const byAccount = await sf.query<{ Id: string }>(
          `SELECT Id FROM Lead WHERE Matched_Account__c = '${escapeSoql(
            session.salesforceAccountId,
          )}' ORDER BY CreatedDate DESC LIMIT 1`,
        );
        leadId = byAccount.records[0]?.Id;
      } catch {
        /* Matched_Account__c lookup not present either — give up. */
      }
    }

    if (leadId) {
      sfResult.leadId = leadId;
      await updateRecordTolerant(
        sf,
        leadId,
        { Online_Registration_Appointment__c: apptCreated.id },
        { context: "register-book/lead-patch", sobject: "Lead" },
      );
    }
  } catch (err) {
    sfResult.error =
      err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    captureServerException(err, {
      tags: {
        portal_route: "register-appointments-book",
        step: "syncSalesforceAppointment",
        severity: "non_fatal",
      },
    });
    console.warn(
      "[Portal:register-book] Salesforce appointment sync failed:",
      err,
    );
  }
  return sfResult;
}

/**
 * Look up a Salesforce `Location` record id by Athena department id.
 * Returns null when no Location row maps to that department (the field
 * `department_Id__c` on Location stores the integer-as-text Athena id).
 */
async function lookupLocationByDepartmentId(
  sf: SalesforceClient,
  athenaDepartmentId: number,
): Promise<string | null> {
  try {
    const safe = String(athenaDepartmentId).replace(/[^0-9]/g, "");
    if (!safe) return null;
    const result = await sf.query<{ Id: string }>(
      `SELECT Id FROM Location WHERE department_Id__c = '${safe}' LIMIT 1`,
    );
    return result.records[0]?.Id ?? null;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-appointments-book",
        step: "lookupLocation",
        severity: "non_fatal",
      },
    });
    return null;
  }
}

/**
 * Look up a Salesforce `Contact` (provider) record id by Athena provider id.
 * Mirrors the Prefect Athena→SF sync, which keys Contact rows by
 * `HealthCloudGA__SourceSystemId__c` = Athena provider id.
 */
async function lookupContactByAthenaId(
  sf: SalesforceClient,
  athenaProviderId: number,
): Promise<string | null> {
  try {
    const safe = String(athenaProviderId).replace(/[^0-9]/g, "");
    if (!safe) return null;
    const result = await sf.query<{ Id: string }>(
      `SELECT Id FROM Contact WHERE HealthCloudGA__SourceSystemId__c = '${safe}' LIMIT 1`,
    );
    return result.records[0]?.Id ?? null;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-appointments-book",
        step: "lookupContact",
        severity: "non_fatal",
      },
    });
    return null;
  }
}

/** Athena returns date as MM/DD/YYYY and starttime as HH:MM (24h). */
function parseAthenaDateTime(
  date: string | undefined,
  starttime: string | undefined,
): string | undefined {
  if (!date) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  const time = starttime && /^\d{1,2}:\d{2}$/.test(starttime)
    ? starttime.padStart(5, "0")
    : "00:00";
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${time}:00Z`;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("register-appointments-book", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const body = await parseJsonBody<BookPayload>(request);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    if (!body.appointmentId) {
      return NextResponse.json(
        { error: "appointmentId is required" },
        { status: 400 }
      );
    }

    // Athena's booking PUT rewrites the slot to whatever appointmenttypeid
    // we send, so an unscoped value here would let a regToken book a slot
    // as a Routine/Urgent/AWV visit. Pin to the registration Initial-Visit
    // allowlist (47/142/223/461). Missing typeid falls through to Athena's
    // server-side default for the slot.
    if (
      body.appointmenttypeid !== undefined &&
      !REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(Number(body.appointmenttypeid))
    ) {
      return NextResponse.json(
        {
          error: "appointmenttypeid is not allowed for the registration flow",
          code: "REGISTRATION_TYPE_NOT_ALLOWED",
        },
        { status: 400 }
      );
    }

    // Pending patient (Athena create soft-failed earlier in the wizard) —
    // we have no real patient to book against. Drop a followup row with
    // the requested slot details and return a soft success so the wizard
    // shows the confirmation page; back-office will book the slot
    // manually after promoting the pending Athena id.
    if (isPendingPatientId(session.athenaPatientId)) {
      const followupId = await recordFollowup({
        step: "appointment_book",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          appointmentId: body.appointmentId,
          appointmenttypeid: body.appointmenttypeid,
          reasonid: body.reasonid,
          bookingnote: body.bookingnote,
          reason: "patient_create soft-failed earlier — pending Athena id",
        },
        errorCode: "PENDING_PATIENT",
      });
      return NextResponse.json({
        appointment: {
          appointmentid: `pending-${followupId ?? Date.now()}`,
          requested: true,
        },
        soft: true,
        pending: true,
        followupId,
        message:
          "Thanks! We've requested this appointment time. Our team will " +
          "confirm with you by text or phone within an hour.",
      });
    }

    const patientIdNum = parseInt(
      String(session.athenaPatientId).replace(/\s+/g, ""),
      10
    );
    if (!Number.isFinite(patientIdNum)) {
      return NextResponse.json(
        { error: "Invalid patient id in registration session" },
        { status: 400 }
      );
    }

    const idemPayload = {
      patientId: patientIdNum,
      appointmentId: body.appointmentId,
    };
    const cached = await idempotencyGet<{ appointment: unknown }>(
      "register-book",
      idemPayload
    );
    if (cached) return NextResponse.json(cached);

    try {
      const appointment = await bookAppointment({
        appointmentId: body.appointmentId,
        patientId: patientIdNum,
        appointmenttypeid: body.appointmenttypeid,
        reasonid: body.reasonid,
        departmentid: session.departmentId,
        bookingnote:
          body.bookingnote ||
          "Initial visit - scheduled via patient portal (no-account flow)",
      });
      const response = { appointment };
      await idempotencySet("register-book", idemPayload, response, 600);

      // Pin the Usual Provider AND the Primary Department on the
      // Athena chart to whatever the patient just booked. Both fields
      // can drift from the demographics-step defaults if the patient
      // changed clinic in the schedule step, and downstream systems
      // (reminders, HEDIS panel attribution, the "Home / PCP" pill on
      // the patient banner) all key off them. Non-blocking: if the PUT
      // fails Athena still has the appointment and the patient; we
      // just lose the chart-level assignments until front-office sets
      // them. The failure is logged to the audit row + Sentry.
      let primaryAssignmentError: string | null = null;
      const apptRow = appointment as Record<string, unknown>;
      const athenaProviderId = apptRow?.providerid ?? body.providerId;
      // Prefer the appointment's department (authoritative) over the
      // registration-session department which may be stale if the
      // patient switched clinics in the schedule step.
      const athenaDepartmentId =
        apptRow?.departmentid ?? body.departmentId ?? session.departmentId;
      if (athenaProviderId || athenaDepartmentId) {
        try {
          const r = await setPatientPrimaryAssignment(patientIdNum, {
            providerId: athenaProviderId
              ? String(athenaProviderId)
              : undefined,
            departmentId: athenaDepartmentId
              ? String(athenaDepartmentId)
              : undefined,
          });
          if (!r.success) {
            primaryAssignmentError =
              r.errormessage ?? "athena returned non-success";
          }
        } catch (e) {
          primaryAssignmentError =
            e instanceof Error ? e.message : String(e);
          captureServerException(e, {
            tags: {
              portal_route: "register-appointments-book",
              athena_op: "set_primary_assignment",
            },
            extra: {
              patientId: patientIdNum,
              providerId: athenaProviderId,
              departmentId: athenaDepartmentId,
            },
          });
        }
      } else {
        primaryAssignmentError =
          "no providerid/departmentid available from appointment or request body";
      }

      // Salesforce sync runs FIRST so the audit row below can include
      // both the Athena response and the SF write outcome (Account /
      // Appointment / Lead ids, location/provider lookup ids, errors).
      const sf = await syncBookingToSalesforce({
        session,
        appointment,
        departmentId: body.departmentId,
        providerId: body.providerId,
        locationName: body.locationName,
        providerName: body.providerName,
        appointmentTypeName: body.appointmentTypeName,
        duration: body.duration,
      });

      // Audit row — every successful booking is captured to Supabase as
      // the backup of record. Includes the Athena response AND the SF
      // sync result. If either system ever loses the record we can
      // replay from this row.
      await recordFollowup({
        step: "appointment_book",
        outcome: "success",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          appointmentId: body.appointmentId,
          appointmenttypeid: body.appointmenttypeid,
          reasonid: body.reasonid,
          bookingnote: body.bookingnote,
          // Lookup hints the wizard sent so SF can resolve real lookups.
          departmentId: body.departmentId,
          providerId: body.providerId,
          locationName: body.locationName,
          providerName: body.providerName,
          appointmentTypeName: body.appointmentTypeName,
          duration: body.duration,
        },
        result: {
          appointment,
          salesforce: {
            accountId: session.salesforceAccountId ?? null,
            appointmentId: sf.appointmentId,
            leadId: sf.leadId,
            locationId: sf.locationId,
            physicianId: sf.physicianId,
            error: sf.error,
          },
          athena: {
            primaryProviderId: athenaProviderId ?? null,
            primaryDepartmentId: athenaDepartmentId ?? null,
            primaryAssignmentError,
          },
        },
        errorCode: sf.error
          ? "SF_BOOKING_SYNC_DEGRADED"
          : primaryAssignmentError
            ? "ATHENA_PRIMARY_ASSIGNMENT_DEGRADED"
            : null,
      });
      // Server-side funnel signal (authoritative — fires only when the
      // Athena PUT actually returned 2xx). Browser sends its own
      // appointment_booked from SchedulingWizard.tsx; this is the
      // server's truth and is the one we'll join against the
      // salesforce_lead_id / followup_audit rows.
      try {
        const distinctId = await hashToOpaqueDistinctId(session.athenaPatientId);
        await captureServerEvent(distinctId, "appointment_booked_server", {
          appointmentTypeId: body.appointmenttypeid,
          // Prefer the department actually persisted on the booked
          // appointment (`athenaDepartmentId` is derived from
          // apptRow/body/session in that order). Falling back to the
          // session value would misattribute bookings whenever the
          // patient changed clinics mid-flow.
          departmentId: athenaDepartmentId ?? session.departmentId,
          salesforceSyncOk: Boolean(sf.appointmentId) && !sf.error,
          primaryAssignmentOk: !primaryAssignmentError,
        });
        await captureServerEvent(distinctId, "onboarding_step_completed", {
          step: "appointment_booked",
          flow: "register",
        });
      } catch {
        // analytics never blocks the response
      }
      return NextResponse.json(response);
    } catch (err) {
      const sentryEventId = captureServerException(err, {
        tags: { portal_route: "register-appointments-book" },
      });

      // Server-side failure event — categorized into the same closed
      // enum the browser uses so funnel insights line up.
      try {
        const distinctId = await hashToOpaqueDistinctId(session.athenaPatientId);
        const status =
          err instanceof AthenaApiError ? err.statusCode : undefined;
        let reason: string = "unknown";
        if (status === 409) reason = "slot_taken";
        else if (status && status >= 500) reason = "athena_5xx";
        else if (status && status >= 400) reason = "athena_4xx";
        await captureServerEvent(distinctId, "appointment_book_failed_server", {
          reason,
          athenaStatus: status,
          appointmentTypeId: body.appointmenttypeid,
          departmentId: session.departmentId,
        });
      } catch {
        // analytics never blocks the response
      }

      // Athena 409 ("slot just taken") is a real user-recoverable signal
      // — the UI MUST prompt for a different slot rather than silently
      // pretending the booking succeeded. Still capture the row so we
      // have the full audit trail of every booking attempt.
      if (err instanceof AthenaApiError && err.statusCode === 409) {
        // Audit-only — patient picks another slot in the same session,
        // back-office never needs to act on these. status='resolved'
        // keeps the queue clean.
        await recordFollowup({
          step: "appointment_book",
          outcome: "soft_failed",
          severity: "info",
          status: "resolved",
          athenaPatientId: session.athenaPatientId,
          departmentId: session.departmentId,
          firstName: session.firstName,
          lastName: session.lastName,
          phone: session.phone,
          email: session.email,
          payload: {
            appointmentId: body.appointmentId,
            appointmenttypeid: body.appointmenttypeid,
            reasonid: body.reasonid,
            bookingnote: body.bookingnote,
          },
          errorCode: "ATHENA_SLOT_TAKEN",
          error: err,
          sentryEventId,
        });
        return NextResponse.json(
          {
            error: "That time was just taken — please pick another slot.",
            code: "ATHENA_SLOT_TAKEN",
            athenaStatus: 409,
          },
          { status: 409 }
        );
      }

      // Everything else (Athena 4xx field issues, 5xx outages, network
      // blips) is a soft-fail: the patient sees a confirmation, we
      // queue a followup, and back-office books the slot manually.
      const followupId = await recordFollowup({
        step: "appointment_book",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          appointmentId: body.appointmentId,
          appointmenttypeid: body.appointmenttypeid,
          reasonid: body.reasonid,
          bookingnote: body.bookingnote,
          athenaStatus: err instanceof AthenaApiError ? err.statusCode : null,
          athenaResponseBody:
            err instanceof AthenaApiError
              ? (err.responseBody || "").slice(0, 500)
              : undefined,
        },
        error: err,
        errorCode:
          err instanceof AthenaApiError
            ? `ATHENA_${err.statusCode}`
            : "ATHENA_APPOINTMENT_BOOK",
        sentryEventId,
      });

      const response = {
        appointment: {
          appointmentid: `pending-${followupId ?? Date.now()}`,
          requested: true,
        },
        soft: true as const,
        followupId,
        message:
          "Thanks! We've requested this appointment time. Our team will " +
          "confirm with you by text or phone within an hour.",
      };
      // Cache the soft response with the same idempotency key so a retry
      // doesn't queue duplicate followups for the same slot.
      await idempotencySet("register-book", idemPayload, response, 600);
      return NextResponse.json(response);
    }
  });
}
