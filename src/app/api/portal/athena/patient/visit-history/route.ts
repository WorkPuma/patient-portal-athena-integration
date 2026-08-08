/**
 * GET /api/portal/athena/patient/visit-history
 *
 * Returns a small summary of the patient's prior visits — used by the
 * scheduling wizard to decide whether the user is "established" (more than
 * one completed visit) and is therefore allowed to pick a chief complaint
 * instead of being forced into an Initial Visit.
 *
 * Athena `appointmentstatus` codes that count as completed:
 *   3 = Checked-out
 *   4 = Charge entered
 */

import { NextResponse } from "next/server";
import { captureServerException } from "@/lib/capture-exception";
import {
  requireVerifiedIdentity,
  isPortalUser,
} from "@/lib/auth/clerk-session";
import { AthenaApiError, getPatientAppointments } from "@/lib/athena/client";
import {
  COMPLETED_APPOINTMENT_STATUSES,
  isEstablishedPatient,
} from "@/lib/scheduling/appointment-types";

export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.athenaPatientId) {
    return NextResponse.json(
      { error: "No Athena patient linked" },
      { status: 400 }
    );
  }

  try {
    const appointments = await getPatientAppointments(user.athenaPatientId, {
      showpast: true,
    });

    let completedVisits = 0;
    let lastVisitDate: string | null = null;

    for (const a of appointments) {
      const status = String(a.appointmentstatus ?? "").trim();
      if (!COMPLETED_APPOINTMENT_STATUSES.has(status)) continue;
      completedVisits += 1;
      const date = typeof a.date === "string" ? a.date : null;
      if (date && (!lastVisitDate || date > lastVisitDate)) {
        lastVisitDate = date;
      }
    }

    return NextResponse.json({
      completedVisits,
      isEstablished: isEstablishedPatient(completedVisits),
      lastVisitDate,
    });
  } catch (error) {
    captureServerException(error, {
      tags: { portal_route: "patient-visit-history" },
    });
    if (error instanceof AthenaApiError) {
      const status =
        error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 502;
      return NextResponse.json(
        {
          error: "We couldn't load your visit history",
          code: "ATHENA_PATIENT_APPOINTMENTS",
          athenaStatus: error.statusCode,
        },
        { status }
      );
    }
    return NextResponse.json(
      { error: "Failed to load visit history" },
      { status: 500 }
    );
  }
}
