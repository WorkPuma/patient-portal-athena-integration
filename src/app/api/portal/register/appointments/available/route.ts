/**
 * GET /api/portal/register/appointments/available
 *   ?startdate=MM/DD/YYYY&enddate=MM/DD/YYYY[&providerid=...&appointmenttypeid=...]
 *
 * Public list of open appointment slots, regToken-authenticated.
 *
 * Department id is taken from the regToken (set during /register/patient) so
 * a registrant cannot poll arbitrary departments.
 *
 * 60s Redis cache per (departmentid, providerid?, appointmenttypeid?, dateRange)
 * combination — Athena slot lookups are 1-3s; this collapses repeated polls
 * during the wizard step.
 */

import { NextRequest, NextResponse } from "next/server";
import { AthenaApiError, getOpenAppointments } from "@/lib/athena/client";
import { captureServerException } from "@/lib/capture-exception";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import { rateLimit } from "@/lib/rate-limit";
import { cacheGet, cacheSet } from "@/lib/upstash/cache";
import { withPortalErrors } from "@/lib/portal/api";
import { listActiveLocations } from "@/lib/portal/locations";
import { listProviderDirectory } from "@/lib/portal/providers";
import {
  REGISTRATION_INITIAL_VISIT_TYPE_IDS,
  filterRegistrationInitialVisitSlots,
  type AthenaOpenSlot,
} from "@/lib/scheduling/appointment-types";

const CACHE_TTL = 60;

/**
 * Minimum lead time in business days. Patients can't book an Initial Visit
 * earlier than this many weekdays from "now" — gives the clinic time to
 * verify insurance, send intake forms, and route any guided-handoff
 * follow-ups before the visit.
 */
const MIN_BOOKING_LEAD_BUSINESS_DAYS = 3;

/** Add `count` business days (Mon-Fri) to `from`, returning the resulting date. */
function addBusinessDays(from: Date, count: number): Date {
  const out = new Date(from);
  let added = 0;
  while (added < count) {
    out.setDate(out.getDate() + 1);
    const dow = out.getDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return out;
}

/** Parse Athena MM/DD/YYYY slot date to a Date at local midnight. */
function parseAthenaDate(s: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

export async function GET(request: NextRequest) {
  return withPortalErrors("register-appointments-available", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const rl = await rateLimit(request, {
      limit: 60,
      window: "1m",
      prefix: "portal-register-slots",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const providerid = request.nextUrl.searchParams.get("providerid");
    const appointmenttypeid = request.nextUrl.searchParams.get("appointmenttypeid");
    const startdate = request.nextUrl.searchParams.get("startdate") || undefined;
    const enddate = request.nextUrl.searchParams.get("enddate") || undefined;
    const departmentidParam = request.nextUrl.searchParams.get("departmentid");

    // The wizard now lets the patient pick a clinic location and provider.
    // We accept those overrides but validate them against our curated
    // location/provider directory so an attacker can't enumerate arbitrary
    // departments/providers in the practice.
    let departmentId = session.departmentId;
    if (departmentidParam) {
      const parsed = parseInt(departmentidParam, 10);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json(
          { error: "Invalid departmentid" },
          { status: 400 }
        );
      }
      const allowedLocations = await listActiveLocations();
      if (!allowedLocations.some((l) => l.departmentid === parsed)) {
        return NextResponse.json(
          { error: "Unknown clinic location" },
          { status: 400 }
        );
      }
      departmentId = parsed;
    }

    let providerIdFiltered: number | undefined;
    if (providerid) {
      const parsed = parseInt(providerid, 10);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json(
          { error: "Invalid providerid" },
          { status: 400 }
        );
      }
      const allowedProviders = await listProviderDirectory();
      if (!allowedProviders.some((p) => p.providerid === parsed)) {
        return NextResponse.json(
          { error: "Unknown provider" },
          { status: 400 }
        );
      }
      providerIdFiltered = parsed;
    }

    // The regToken is scoped to the new-patient Initial Visit. Reject any
    // `appointmenttypeid` outside the curated registration allowlist so a
    // regToken can't be repurposed to enumerate Routine/Urgent/AWV/etc.
    // open slots in the practice.
    let appointmentTypeIdFiltered: number | undefined;
    if (appointmenttypeid) {
      const parsed = parseInt(appointmenttypeid, 10);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json(
          { error: "Invalid appointmenttypeid" },
          { status: 400 }
        );
      }
      if (!REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(parsed)) {
        return NextResponse.json(
          {
            error:
              "appointmenttypeid is not allowed for the registration flow",
            code: "REGISTRATION_TYPE_NOT_ALLOWED",
          },
          { status: 400 }
        );
      }
      appointmentTypeIdFiltered = parsed;
    }

    const cacheKey = [
      "slots",
      departmentId,
      providerIdFiltered ?? "any",
      appointmentTypeIdFiltered ?? "any",
      startdate || "any",
      enddate || "any",
    ].join(":");

    const cached = await cacheGet<{ appointments: unknown[] }>(cacheKey, {
      prefix: "portal",
    });
    if (cached) return NextResponse.json({ ...cached, cached: true });

    try {
      const appointments = await getOpenAppointments({
        departmentid: departmentId,
        providerid: providerIdFiltered,
        appointmenttypeid: appointmentTypeIdFiltered,
        startdate,
        enddate,
      });

      // Hide any slot earlier than the minimum booking lead time. Athena
      // returns slots ordered by date; we filter rather than nudge the
      // start date server-side so a misconfigured client request can't
      // bypass the gate.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const earliest = addBusinessDays(today, MIN_BOOKING_LEAD_BUSINESS_DAYS);
      const dateFiltered = (appointments ?? []).filter((slot) => {
        const d = parseAthenaDate(String((slot as { date?: string }).date ?? ""));
        return d ? d >= earliest : false;
      });

      // Strip Athena's generic-pool expansions that don't match the
      // queried Initial Visit type. Without this:
      //   - typeid 47  / 142 / 223  (90-min Initial)  would include
      //     60-min "Any 60 (AWV, PreOp, TOC)" slots in the response.
      //   - typeid 461 (60-min MBR Initial) would include "Any 60",
      //     "Any 20" generics. Per product policy we never substitute a
      //     generic pool for a commercial Initial Visit — only the
      //     dedicated MBR Initial (461) counts.
      // Slot kept ⇔ acceptable for the queried registration type.
      const filtered = filterRegistrationInitialVisitSlots(
        dateFiltered as unknown as AthenaOpenSlot[],
        appointmentTypeIdFiltered
      );

      const payload = { appointments: filtered };
      await cacheSet(cacheKey, payload, { prefix: "portal", ttl: CACHE_TTL });
      return NextResponse.json({ ...payload, cached: false });
    } catch (err) {
      captureServerException(err, {
        tags: { portal_route: "register-appointments-available" },
      });
      if (err instanceof AthenaApiError) {
        const status =
          err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
        return NextResponse.json(
          {
            error: "We couldn't load available times",
            code: "ATHENA_OPEN_SLOTS",
            athenaStatus: err.statusCode,
          },
          { status }
        );
      }
      return NextResponse.json(
        { error: "Failed to fetch available appointments" },
        { status: 500 }
      );
    }
  });
}
