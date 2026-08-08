import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { getOpenAppointments, AthenaApiError } from "@/lib/athena/client";

/**
 * GET /api/portal/athena/appointments/available?departmentid=...&providerid=...
 * List open appointment slots.
 */
export async function GET(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;

  const departmentid = request.nextUrl.searchParams.get("departmentid");
  if (!departmentid) {
    return NextResponse.json(
      { error: "departmentid is required" },
      { status: 400 }
    );
  }

  try {
    const providerid = request.nextUrl.searchParams.get("providerid");
    const appointmenttypeid = request.nextUrl.searchParams.get("appointmenttypeid");
    const startdate = request.nextUrl.searchParams.get("startdate");
    const enddate = request.nextUrl.searchParams.get("enddate");

    const appointments = await getOpenAppointments({
      departmentid: parseInt(departmentid, 10),
      providerid: providerid ? parseInt(providerid, 10) : undefined,
      appointmenttypeid: appointmenttypeid
        ? parseInt(appointmenttypeid, 10)
        : undefined,
      startdate: startdate || undefined,
      enddate: enddate || undefined,
    });

    return NextResponse.json({ appointments });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      const clientStatus = code >= 400 && code < 500 ? code : 502;
      return NextResponse.json(
        {
          error: "Athena refused open slots request",
          code: "ATHENA_OPEN_SLOTS",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status: clientStatus }
      );
    }
    console.error("[Portal] Open appointments error:", error);
    return NextResponse.json(
      { error: "Failed to fetch available appointments" },
      { status: 500 }
    );
  }
}
