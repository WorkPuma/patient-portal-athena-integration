import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { AthenaApiError, bookAppointment } from "@/lib/athena/client";
import { captureServerEvent } from "@/lib/posthog/server";

/**
 * POST /api/portal/athena/appointments/book
 * Book an open appointment slot.
 */
export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.athenaPatientId) {
    return NextResponse.json(
      { error: "No Athena patient linked" },
      { status: 400 }
    );
  }

  const patientIdNum = parseInt(
    String(user.athenaPatientId).replace(/\s+/g, ""),
    10
  );
  if (!Number.isFinite(patientIdNum)) {
    return NextResponse.json(
      { error: "Invalid Athena patient id in profile" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { appointmentId, appointmenttypeid, reasonid, departmentid, bookingnote } =
    body as {
      appointmentId: number;
      appointmenttypeid?: number;
      reasonid?: number;
      departmentid?: number;
      bookingnote?: string;
    };

  if (!appointmentId) {
    return NextResponse.json(
      { error: "appointmentId is required" },
      { status: 400 }
    );
  }

  try {
    const appointment = await bookAppointment({
      appointmentId,
      patientId: patientIdNum,
      appointmenttypeid,
      reasonid,
      departmentid,
      bookingnote,
    });

    try {
      await captureServerEvent(user.userId, "appointment_booked_portal_server", {
        appointment_type_id: appointmenttypeid ?? null,
        department_id: departmentid ?? null,
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({ appointment });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      const clientStatus = code >= 400 && code < 500 ? code : 502;
      return NextResponse.json(
        {
          error: "Athena refused booking",
          code: "ATHENA_APPOINTMENT_BOOK",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status: clientStatus }
      );
    }
    console.error("[Portal] Book appointment error:", error);
    return NextResponse.json(
      { error: "Failed to book appointment" },
      { status: 500 }
    );
  }
}
