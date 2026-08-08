import { NextRequest, NextResponse } from "next/server";
import {
  requireVerifiedIdentity,
  isPortalUser,
} from "@/lib/auth/clerk-session";
import { cancelAppointment } from "@/lib/athena/client";
import { captureServerEvent } from "@/lib/posthog/server";

/**
 * PUT /api/portal/athena/appointments/[id]/cancel
 * Cancel an appointment via the Athena API.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const { id: appointmentId } = await params;
  const body = await request.json();
  const { reason } = body as { reason?: string };

  if (!user.athenaPatientId) {
    return NextResponse.json(
      { error: "No Athena patient linked" },
      { status: 400 }
    );
  }

  try {
    await cancelAppointment(
      appointmentId,
      user.athenaPatientId,
      reason || "Cancelled via patient portal"
    );

    try {
      await captureServerEvent(user.userId, "appointment_cancelled_server", {
        appointment_id: appointmentId,
      });
    } catch {
      // analytics never blocks the response
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Portal] Cancel appointment error:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 }
    );
  }
}
