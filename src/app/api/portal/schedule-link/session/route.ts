/**
 * POST /api/portal/schedule-link/session
 *
 * Bootstraps the standalone scheduler from a schedule-link token. Read-only:
 * it never burns the link (booking does). Returns:
 *   - mode: "reschedule" (cancelled a visit within 30 days) vs "schedule"
 *   - the recent cancellation to offer back (reschedule mode)
 *   - the patient's home clinic + PCP (schedule mode start point)
 *   - tier cadence nudge (Risk_Tier__c / Off_Cadence_Actual__c)
 *   - MDDO / AWV follow-up eligibility
 *   - the clinic list (for switching clinics)
 *
 * Auth: the signed token in the request body (self-verifying route).
 */

import { NextRequest, NextResponse } from "next/server";
import { withPortalErrors, parseJsonBody } from "@/lib/portal/api";
import {
  requireScheduleLinkToken,
  isScheduleLinkSession,
} from "@/lib/scheduling/schedule-link-session";
import {
  getPatient,
  getPatientAppointments,
  getDepartments,
  getProviders,
  AthenaApiError,
} from "@/lib/athena/client";
import {
  findRecentCancellation,
  resolveScheduleMode,
} from "@/lib/scheduling/reschedule";
import { getAccountSchedulingContext } from "@/lib/salesforce/scheduling-context";
import {
  getTierPolicy,
  getTierCadenceMessage,
} from "@/lib/scheduling/tier-policy";

interface SessionBody {
  token?: string;
}

function providerName(p: {
  displayname?: string;
  firstname?: string;
  lastname?: string;
}): string {
  return (
    p.displayname ||
    [p.firstname, p.lastname].filter(Boolean).join(" ").trim() ||
    "Your provider"
  );
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-session", async () => {
    const body = await parseJsonBody<SessionBody>(request);
    const guard = await requireScheduleLinkToken(body?.token);
    if (!isScheduleLinkSession(guard)) return guard;
    const session = guard;

    const patientId = String(session.athenaPatientId);

    // Parallel fan-out. Each piece degrades independently — a Salesforce or
    // provider-directory hiccup should not blank the whole scheduler.
    const [patientRes, apptsRes, deptsRes, providersRes, sfRes] =
      await Promise.allSettled([
        getPatient(patientId),
        getPatientAppointments(patientId, { showpast: true }),
        getDepartments(),
        getProviders(),
        session.salesforceAccountId
          ? getAccountSchedulingContext(session.salesforceAccountId)
          : Promise.resolve(null),
      ]);

    const patient =
      patientRes.status === "fulfilled" ? patientRes.value : null;
    const appointments =
      apptsRes.status === "fulfilled" ? apptsRes.value : [];
    const departments =
      deptsRes.status === "fulfilled" ? deptsRes.value : [];
    const providers =
      providersRes.status === "fulfilled" ? providersRes.value : [];
    const sfContext = sfRes.status === "fulfilled" ? sfRes.value : null;

    // If the patient record itself failed AND it's an Athena auth/5xx, the
    // link can't function — surface a clean error.
    if (!patient && apptsRes.status === "rejected") {
      const err = apptsRes.reason;
      if (err instanceof AthenaApiError && err.statusCode >= 500) {
        return NextResponse.json(
          {
            ok: false,
            code: "ATHENA_UNAVAILABLE",
            error: "We're having trouble loading your information. Please try again shortly.",
          },
          { status: 502 }
        );
      }
    }

    // Reschedule vs schedule.
    const recentCancellation = findRecentCancellation(appointments);
    const mode = resolveScheduleMode(recentCancellation);

    // Home clinic + PCP from the Athena chart.
    const primaryDeptId =
      patient?.primarydepartmentid !== null &&
      patient?.primarydepartmentid !== undefined
        ? String(patient.primarydepartmentid)
        : session.departmentId !== null && session.departmentId !== undefined
        ? String(session.departmentId)
        : null;
    const primaryProviderId =
      patient?.primaryproviderid !== null &&
      patient?.primaryproviderid !== undefined
        ? String(patient.primaryproviderid)
        : null;

    const clinic = primaryDeptId
      ? {
          departmentId: primaryDeptId,
          name:
            departments.find((d) => String(d.departmentid) === primaryDeptId)
              ?.name ?? "Your clinic",
        }
      : null;

    const pcpProvider = primaryProviderId
      ? providers.find((p) => String(p.providerid) === primaryProviderId)
      : undefined;
    const pcp =
      primaryProviderId && pcpProvider
        ? { providerId: primaryProviderId, name: providerName(pcpProvider) }
        : primaryProviderId
        ? { providerId: primaryProviderId, name: "Your provider" }
        : null;

    // Tier cadence nudge.
    let tier = null as null | {
      riskTier: string | null;
      label: string;
      visitsPerYear: number;
      cadenceLabel: string;
      offCadence: boolean | null;
      message: string;
    };
    if (sfContext) {
      const policy = getTierPolicy(sfContext.riskTier);
      tier = {
        riskTier: sfContext.riskTier,
        label: policy.label,
        visitsPerYear: policy.visitsPerYear,
        cadenceLabel: policy.cadenceLabel,
        offCadence: sfContext.offCadence,
        message: getTierCadenceMessage(policy, sfContext.offCadence),
      };
    }

    // Clinic list for switching — patient-facing fields only.
    const clinicOptions = departments
      .filter((d) => d.departmentid && d.name)
      .map((d) => ({ departmentId: String(d.departmentid), name: String(d.name) }));

    return NextResponse.json({
      ok: true,
      mode,
      patient: { firstName: session.firstName ?? patient?.firstname ?? null },
      recentCancellation,
      clinic,
      pcp,
      tier,
      followUps: {
        mddo: Boolean(sfContext?.mddoEligible),
        awv: Boolean(sfContext?.awvEligible),
      },
      clinics: clinicOptions,
    });
  });
}
