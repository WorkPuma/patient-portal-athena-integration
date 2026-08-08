/**
 * POST /api/portal/schedule-link/available
 *
 * Open-slot lookup for the standalone scheduler. Token-authed (single-use
 * link must still be active). Read-only — never burns the link.
 *
 * Body: { token, departmentId, providerId?, appointmenttypeid?, startdate?, enddate? }
 */

import { NextRequest, NextResponse } from "next/server";
import { withPortalErrors, parseJsonBody } from "@/lib/portal/api";
import {
  requireScheduleLinkToken,
  isScheduleLinkSession,
} from "@/lib/scheduling/schedule-link-session";
import { getOpenAppointments, AthenaApiError } from "@/lib/athena/client";
import {
  parseOptionalPositiveInt,
  parseRequiredPositiveInt,
} from "@/lib/scheduling/numeric";

interface AvailableBody {
  token?: string;
  departmentId?: number | string;
  providerId?: number | string;
  appointmenttypeid?: number | string;
  startdate?: string;
  enddate?: string;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-available", async () => {
    const body = await parseJsonBody<AvailableBody>(request);
    const guard = await requireScheduleLinkToken(body?.token, {
      requireUnused: true,
    });
    if (!isScheduleLinkSession(guard)) return guard;

    const departmentParsed = parseRequiredPositiveInt(
      body?.departmentId,
      "departmentId",
    );
    if (!departmentParsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          error: departmentParsed.error,
        },
        { status: 400 }
      );
    }
    const departmentId = departmentParsed.value;

    const providerId = parseOptionalPositiveInt(body?.providerId);
    if (providerId === null) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", error: "providerId must be a positive integer" },
        { status: 400 }
      );
    }
    const appointmenttypeid = parseOptionalPositiveInt(body?.appointmenttypeid);
    if (appointmenttypeid === null) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          error: "appointmenttypeid must be a positive integer",
        },
        { status: 400 }
      );
    }

    try {
      const appointments = await getOpenAppointments({
        departmentid: departmentId,
        providerid: providerId,
        appointmenttypeid,
        startdate: body?.startdate || undefined,
        enddate: body?.enddate || undefined,
      });
      return NextResponse.json({ ok: true, appointments });
    } catch (error) {
      if (error instanceof AthenaApiError) {
        const code = error.statusCode;
        const clientStatus = code >= 400 && code < 500 ? code : 502;
        return NextResponse.json(
          {
            ok: false,
            code: "ATHENA_OPEN_SLOTS",
            error: "Could not load available times.",
            athenaStatus: code,
          },
          { status: clientStatus }
        );
      }
      throw error;
    }
  });
}
