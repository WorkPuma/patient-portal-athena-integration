import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { rescheduleAppointment } from "@/lib/athena/client";

/**
 * PUT /api/portal/athena/appointments/[id]/reschedule
 * Cancel old appointment and book a new one.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const { id: oldId } = await params;
  const body = await request.json();
  const { newAppointmentId, reasonid, reschedulereason } = body as {
    newAppointmentId: number;
    reasonid?: number;
    reschedulereason?: string;
  };

  if (!newAppointmentId) {
    return NextResponse.json(
      { error: "newAppointmentId is required" },
      { status: 400 }
    );
  }

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

  try {
    const appointment = await rescheduleAppointment(
      oldId,
      newAppointmentId,
      patientIdNum,
      { reasonid, reschedulereason }
    );

    return NextResponse.json({ appointment });
  } catch (error) {
    console.error("[Portal] Reschedule error:", error);
    return NextResponse.json(
      { error: "Failed to reschedule appointment" },
      { status: 500 }
    );
  }
}
