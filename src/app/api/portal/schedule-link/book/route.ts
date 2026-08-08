/**
 * POST /api/portal/schedule-link/book
 *
 * Book an open slot from the standalone (no-login) scheduler. Token-authed.
 *
 * Single-use safety: the link's jti is burned ATOMICALLY before the Athena
 * PUT so a double-tap can't double-book. If Athena then rejects the booking
 * with a recoverable error (e.g. 409 slot just taken), the link is restored
 * to "active" so the patient can pick another time with the same link.
 *
 * Body: {
 *   token, appointmentId, appointmenttypeid?, reasonid?, departmentId?,
 *   providerId?, bookingnote?, locationName?, providerName?,
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
  bookAppointment,
  setPatientPrimaryAssignment,
} from "@/lib/athena/client";
import { syncScheduleLinkBooking } from "@/lib/scheduling/schedule-link-salesforce";
import {
  parseOptionalPositiveInt,
  parseRequiredPositiveInt,
} from "@/lib/scheduling/numeric";

interface BookBody {
  token?: string;
  appointmentId?: number | string;
  appointmenttypeid?: number | string;
  reasonid?: number | string;
  departmentId?: number | string;
  providerId?: number | string;
  bookingnote?: string;
  locationName?: string;
  providerName?: string;
  appointmentTypeName?: string;
  duration?: number;
}

function remainingTtlSeconds(exp: number): number {
  return Math.max(60, exp - Math.floor(Date.now() / 1000));
}

type OptionalIds = {
  appointmenttypeid?: number;
  reasonid?: number;
  departmentId?: number;
  providerId?: number;
};

/**
 * Strictly parse the optional numeric ids on the body. Present-but-malformed
 * values (NaN, decimals, "") are rejected with a 400 instead of silently
 * coerced; absent values stay undefined.
 */
function parseOptionalIds(
  body: BookBody | null
):
  | { ok: true; values: OptionalIds }
  | { ok: false; response: NextResponse } {
  const fields: Array<keyof OptionalIds> = [
    "appointmenttypeid",
    "reasonid",
    "departmentId",
    "providerId",
  ];
  const values: OptionalIds = {};
  for (const field of fields) {
    const parsed = parseOptionalPositiveInt(body?.[field]);
    if (parsed === null) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            ok: false,
            code: "BAD_REQUEST",
            error: `${field} must be a positive integer`,
          },
          { status: 400 }
        ),
      };
    }
    if (parsed !== undefined) {
      values[field] = parsed;
    }
  }
  return { ok: true, values };
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-book", async () => {
    const body = await parseJsonBody<BookBody>(request);
    const guard = await requireScheduleLinkToken(body?.token, {
      requireUnused: true,
    });
    if (!isScheduleLinkSession(guard)) return guard;
    const session = guard;

    const appointmentParsed = parseRequiredPositiveInt(
      body?.appointmentId,
      "appointmentId",
    );
    if (!appointmentParsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          error: appointmentParsed.error,
        },
        { status: 400 }
      );
    }
    const appointmentId = appointmentParsed.value;

    // Optional numeric ids: reject malformed values up front so we never
    // forward NaN to Athena or Salesforce.
    const optionalIds = parseOptionalIds(body);
    if (!optionalIds.ok) return optionalIds.response;
    const { appointmenttypeid, reasonid, departmentId, providerId } =
      optionalIds.values;

    // Burn the link atomically up front so concurrent submits can't both
    // book. If we lose the race / the link was already used, stop here.
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
      const appointment = await bookAppointment({
        appointmentId,
        patientId: session.patientIdNum,
        appointmenttypeid,
        reasonid,
        departmentid: departmentId,
        bookingnote:
          body?.bookingnote || "Scheduled via secure SMS link (no-login flow)",
      });

      // Pin Usual Provider + Primary Department to the booked clinic so
      // reminders / panel attribution follow the visit. Non-blocking.
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
              portal_route: "schedule-link-book",
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
      // Recoverable: restore the link so the patient can retry with a new
      // slot in the same session.
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
            code: "ATHENA_APPOINTMENT_BOOK",
            error: "We couldn't book that time. Please try another.",
            athenaStatus: code,
          },
          { status: clientStatus }
        );
      }
      throw err;
    }
  });
}
