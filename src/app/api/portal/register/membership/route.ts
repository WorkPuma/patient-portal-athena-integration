/**
 * POST /api/portal/register/membership
 *
 * Enroll the in-progress registrant in a HINT membership plan.
 *
 * Pre-conditions checked here:
 *   1. Hint patient exists (lazily created via ensureHintPatient if needed).
 *   2. The patient already has at least one stored payment method (the
 *      /payment-method route attaches a Rainforest-tokenized card or ACH
 *      account before this is called). Without a payment method, Hint will
 *      create the membership but never bill it cleanly — we'd rather hard
 *      fail with NO_PAYMENT_METHOD so the wizard can prompt the user.
 *
 * Allowed bypass: pass `skipPaymentCheck: true` in the body for staff/E2E
 * tooling running in non-production envs only. Production always enforces it.
 */

import { NextRequest, NextResponse } from "next/server";
import { captureServerException } from "@/lib/capture-exception";
import {
  HintApiError,
  enrollMember,
  listPaymentMethods,
} from "@/lib/hint/client";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import {
  withPortalErrors,
  parseJsonBody,
  idempotencyGet,
  idempotencySet,
} from "@/lib/portal/api";
import { ensureHintPatient } from "@/lib/portal/hint-patient";
import { membershipDisabledResponse } from "@/lib/portal/membership-guard";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";

interface EnrollPayload {
  planId: string;
  startDate?: string;
  /**
   * Hint billing cadence. Pass 1 for monthly plans, 12 for annual.
   * Defaults to 1 (monthly) if omitted, matching Hint's API default.
   */
  periodInMonths?: 1 | 3 | 6 | 12;
  /** Non-prod escape hatch for the E2E script. Ignored in production. */
  skipPaymentCheck?: boolean;
}

const ALLOWED_PERIODS = new Set<number>([1, 3, 6, 12]);

export async function POST(request: NextRequest) {
  const disabled = membershipDisabledResponse();
  if (disabled) return disabled;
  return withPortalErrors("register-membership", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const body = await parseJsonBody<EnrollPayload>(request);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    if (!body.planId) {
      return NextResponse.json(
        { error: "planId is required" },
        { status: 400 }
      );
    }

    const periodInMonths: 1 | 3 | 6 | 12 =
      typeof body.periodInMonths === "number" &&
        ALLOWED_PERIODS.has(body.periodInMonths)
        ? (body.periodInMonths as 1 | 3 | 6 | 12)
        : 1;

    const idemPayload = {
      athenaPatientId: session.athenaPatientId,
      planId: body.planId,
      startDate: body.startDate || null,
      periodInMonths,
    };
    const cached = await idempotencyGet<{ membership: unknown }>(
      "register-membership",
      idemPayload
    );
    if (cached) return NextResponse.json(cached);

    const ensured = await ensureHintPatient(session, "register-membership");
    if (!ensured.ok) return ensured.response;
    const hintPatientId = ensured.hintPatientId;

    const allowSkip =
      body.skipPaymentCheck === true && process.env.VERCEL_ENV !== "production";

    if (!allowSkip) {
      try {
        const methods = await listPaymentMethods(hintPatientId);
        if (!Array.isArray(methods) || methods.length === 0) {
          return NextResponse.json(
            {
              error:
                "No payment method on file. Add a card or bank account before enrolling.",
              code: "NO_PAYMENT_METHOD",
            },
            { status: 400 }
          );
        }
      } catch (err) {
        captureServerException(err, {
          tags: {
            portal_route: "register-membership",
            step: "listPaymentMethods",
          },
        });
        // Fail closed — refuse to enroll if we can't confirm payment exists.
        return NextResponse.json(
          {
            error: "Could not verify payment method on file. Please retry.",
            code: "PAYMENT_METHOD_LOOKUP_FAILED",
          },
          { status: 502 }
        );
      }
    }

    try {
      const membership = await enrollMember({
        patient_id: hintPatientId,
        plan_id: body.planId,
        start_date: body.startDate,
        period_in_months: periodInMonths,
      });

      // Surface the Hint billing fields the success screen wants to render.
      const m = membership as Record<string, unknown>;
      const summary = {
        id: typeof m.id === "string" ? m.id : undefined,
        status: typeof m.status === "string" ? m.status : undefined,
        bill_date: typeof m.bill_date === "string" ? m.bill_date : undefined,
        next_bill_date:
          typeof m.next_bill_date === "string" ? m.next_bill_date : undefined,
        period_rate_in_cents:
          typeof m.period_rate_in_cents === "number"
            ? m.period_rate_in_cents
            : undefined,
        period_in_months:
          typeof m.period_in_months === "number"
            ? m.period_in_months
            : undefined,
      };

      const response = {
        membership,
        membershipSummary: summary,
        hintPatientId,
        regToken: ensured.refreshedRegToken,
      };
      await idempotencySet("register-membership", idemPayload, response, 300);

      try {
        const distinctId = await hashToOpaqueDistinctId(session.athenaPatientId);
        await captureServerEvent(distinctId, "membership_enrolled_server", {
          plan_id: body.planId,
          period_in_months: periodInMonths,
          flow: "registration",
        });
      } catch {
        // analytics never blocks the response
      }

      return NextResponse.json(response);
    } catch (err) {
      captureServerException(err, {
        tags: { portal_route: "register-membership", step: "enroll" },
      });
      if (err instanceof HintApiError) {
        let hintError: unknown = undefined;
        if (typeof err.responseBody === "string" && err.responseBody.length) {
          try {
            hintError = JSON.parse(err.responseBody);
          } catch {
            hintError = err.responseBody;
          }
        }
        return NextResponse.json(
          {
            error: "Failed to enroll in membership",
            code: "HINT_ENROLL",
            hintStatus: err.statusCode,
            hintError,
          },
          {
            status:
              err.statusCode >= 400 && err.statusCode < 500
                ? err.statusCode
                : 502,
          }
        );
      }
      return NextResponse.json(
        { error: "Failed to enroll in membership" },
        { status: 500 }
      );
    }
  });
}
