/**
 * POST /api/portal/register/membership/payment-method
 *
 * After Rainforest's `<rainforest-payment>` web component fires the `approved`
 * event with a `payment_method_id`, the browser POSTs that token here. We
 * attach it to the Hint patient as the default payment method so the
 * subsequent enroll call (`POST /api/portal/register/membership`) picks it up
 * automatically.
 *
 * Body:
 *   { rainforest_id: string, default?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";

import { captureServerException } from "@/lib/capture-exception";
import {
  HintApiError,
  attachPaymentMethod,
} from "@/lib/hint/client";
import {
  isVerifiedRegistration,
  requireRegistrationToken,
} from "@/lib/auth/registration-session";
import {
  parseJsonBody,
  withPortalErrors,
} from "@/lib/portal/api";
import { ensureHintPatient } from "@/lib/portal/hint-patient";
import { membershipDisabledResponse } from "@/lib/portal/membership-guard";

interface AttachPayload {
  rainforest_id?: string;
  default?: boolean;
}

const RAINFOREST_ID_RE = /^[A-Za-z0-9_\-]{8,128}$/;

export async function POST(request: NextRequest) {
  const disabled = membershipDisabledResponse();
  if (disabled) return disabled;
  return withPortalErrors("register-membership-payment-method", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const body = await parseJsonBody<AttachPayload>(request);
    if (!body || typeof body.rainforest_id !== "string") {
      return NextResponse.json(
        {
          error: "rainforest_id is required",
          code: "MISSING_RAINFOREST_ID",
        },
        { status: 400 }
      );
    }
    if (!RAINFOREST_ID_RE.test(body.rainforest_id)) {
      return NextResponse.json(
        {
          error: "rainforest_id is malformed",
          code: "INVALID_RAINFOREST_ID",
        },
        { status: 400 }
      );
    }

    const ensured = await ensureHintPatient(
      session,
      "register-membership-payment-method"
    );
    if (!ensured.ok) return ensured.response;

    try {
      const paymentMethod = await attachPaymentMethod(ensured.hintPatientId, {
        rainforest_id: body.rainforest_id,
        default: body.default ?? true,
      });

      return NextResponse.json({
        paymentMethod,
        hintPatientId: ensured.hintPatientId,
        regToken: ensured.refreshedRegToken,
      });
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-membership-payment-method",
          step: "attachPaymentMethod",
        },
      });
      if (err instanceof HintApiError) {
        return NextResponse.json(
          {
            error: "Failed to attach payment method",
            code: "HINT_ATTACH_PAYMENT_METHOD",
            hintStatus: err.statusCode,
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
        { error: "Failed to attach payment method" },
        { status: 500 }
      );
    }
  });
}
