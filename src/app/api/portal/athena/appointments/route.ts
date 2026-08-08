import { NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  AthenaApiError,
  getPatientAppointments,
} from "@/lib/athena/client";

/**
 * GET /api/portal/athena/appointments
 * List appointments for the authenticated patient.
 */
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

  const patientId = user.athenaPatientId.replace(/\s+/g, "");
  if (!/^\d+$/.test(patientId)) {
    return NextResponse.json(
      {
        error: "Invalid Athena patient id in profile",
        athenaPatientId: user.athenaPatientId,
      },
      { status: 400 }
    );
  }

  try {
    const today = new Date();
    const startdate = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;

    const appointments = await getPatientAppointments(patientId, {
      startdate,
      showpast: true,
    });

    return NextResponse.json({ appointments });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      if (code === 404) {
        return NextResponse.json(
          {
            error: "Patient not found in Athena",
            detail: error.responseBody?.slice(0, 500),
          },
          { status: 404 }
        );
      }
      const clientStatus = code >= 400 && code < 500 ? code : 502;
      return NextResponse.json(
        {
          error: "Athena refused appointment list",
          code: "ATHENA_APPOINTMENTS_LIST",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status: clientStatus }
      );
    }
    console.error("[Portal] Athena appointments error:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointments" },
      { status: 500 }
    );
  }
}
