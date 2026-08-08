/**
 * POST /api/portal/schedule-link/reschedule
 *
 * Reschedule an existing appointment to a newly chosen open slot from the
 * standalone (no-login) scheduler. Token-authed, single-use (same burn /
 * restore semantics as the book route).
 *
 * Body: {
 *   token, oldAppointmentId, newAppointmentId, reasonid?, reschedulereason?,
 *   departmentId?, providerId?, locationName?, providerName?,
 *   appointmentTypeName?, duration?
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { withPortalErrors, parseJsonBody } from "@/lib/portal/api";
import { captureServerException } from "@/lib/capture-exception";
import {
  requireScheduleLinkToken,
  isScheduleLinkSession,
} from "@/lib/scheduling/schedule-link-session";
import {
  consumeLink,
  reactivateLink,
} from "@/lib/scheduling/schedule-link-store";
import {
  AthenaApiError,
  rescheduleAppointment,
  setPatientPrimaryAssignment,
} from "@/lib/athena/client";
import { syncScheduleLinkBooking } from "@/lib/scheduling/schedule-link-salesforce";
import {
  parseOptionalPositiveInt,
  parseRequiredPositiveInt,
} from "@/lib/scheduling/numeric";

interface RescheduleBody {
  token?: string;
  oldAppointmentId?: number | string;
  newAppointmentId?: number | string;
  reasonid?: number | string;
  reschedulereason?: string;
  departmentId?: number | string;
  providerId?: number | string;
  locationName?: string;
  providerName?: string;
  appointmentTypeName?: string;
  duration?: number;
}

function remainingTtlSeconds(exp: number): number {
  return Math.max(60, exp - Math.floor(Date.now() / 1000));
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-reschedule", async () => {
    const body = await parseJsonBody<RescheduleBody>(request);
    const guard = await requireScheduleLinkToken(body?.token, {
      requireUnused: true,
    });
    if (!isScheduleLinkSession(guard)) return guard;
    const session = guard;

    const oldParsed = parseRequiredPositiveInt(
      body?.oldAppointmentId,
      "oldAppointmentId",
    );
    const newParsed = parseRequiredPositiveInt(
      body?.newAppointmentId,
      "newAppointmentId",
    );
    if (!oldParsed.ok || !newParsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          error:
            !oldParsed.ok
              ? oldParsed.error
              : !newParsed.ok
                ? newParsed.error
                : "oldAppointmentId and newAppointmentId must be positive integers",
        },
        { status: 400 }
      );
    }
    const oldIdNum = oldParsed.value;
    const newAppointmentId = newParsed.value;
    const oldId = String(oldIdNum);

    const reasonid = parseOptionalPositiveInt(body?.reasonid);
    const departmentId = parseOptionalPositiveInt(body?.departmentId);
    const providerId = parseOptionalPositiveInt(body?.providerId);
    if (reasonid === null || departmentId === null || providerId === null) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          error: "reasonid, departmentId and providerId must be positive integers",
        },
        { status: 400 }
      );
    }

    const consumed = await consumeLink(session.jti);
    if (!consumed.ok) {
      const status = consumed.state === "used" ? 409 : 410;
      return NextResponse.json(
        {
          ok: false,
          code:
            consumed.state === "used"
              ? "SCHEDULE_LINK_USED"
              : "SCHEDULE_LINK_EXPIRED",
          error:
            consumed.state === "used"
              ? "This scheduling link has already been used."
              : "This scheduling link is no longer valid.",
        },
        { status }
      );
    }

    const ttl = remainingTtlSeconds(session.exp);

    try {
      const appointment = await rescheduleAppointment(
        oldId,
        newAppointmentId,
        session.patientIdNum,
        {
          reasonid,
          reschedulereason:
            body?.reschedulereason || "Rescheduled via secure SMS link",
        }
      );

      const apptRow = appointment as Record<string, unknown>;
      const provId = apptRow?.providerid ?? providerId;
      const deptId =
        apptRow?.departmentid ?? departmentId ?? session.departmentId;
      if (provId || deptId) {
        try {
          await setPatientPrimaryAssignment(session.patientIdNum, {
            providerId: provId ? String(provId) : undefined,
            departmentId: deptId ? String(deptId) : undefined,
          });
        } catch (e) {
          captureServerException(e, {
            tags: {
              portal_route: "schedule-link-reschedule",
              athena_op: "set_primary_assignment",
              severity: "non_fatal",
            },
          });
        }
      }

      const sf = await syncScheduleLinkBooking({
        salesforceAccountId: session.salesforceAccountId,
        appointment,
        departmentId,
        providerId,
        locationName: body?.locationName,
        providerName: body?.providerName,
        appointmentTypeName: body?.appointmentTypeName,
        duration: body?.duration,
        status: "Scheduled",
      });

      return NextResponse.json({
        ok: true,
        appointment,
        salesforce: { appointmentId: sf.appointmentId, error: sf.error },
      });
    } catch (err) {
      await reactivateLink(session.jti, ttl);

      if (err instanceof AthenaApiError) {
        const code = err.statusCode;
        if (code === 409) {
          return NextResponse.json(
            {
              ok: false,
              code: "ATHENA_SLOT_TAKEN",
              error: "That time was just taken — please pick another slot.",
              athenaStatus: 409,
            },
            { status: 409 }
          );
        }
        const clientStatus = code >= 400 && code < 500 ? code : 502;
        return NextResponse.json(
          {
            ok: false,
            code: "ATHENA_RESCHEDULE",
            error: "We couldn't reschedule to that time. Please try another.",
            athenaStatus: code,
          },
          { status: clientStatus }
        );
      }
      throw err;
    }
  });
}
