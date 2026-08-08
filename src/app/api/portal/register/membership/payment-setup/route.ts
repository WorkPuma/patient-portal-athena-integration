/**
 * POST /api/portal/register/membership/payment-setup
 *
 * Creates (or reuses) the Hint patient for the in-progress registrant, then
 * asks Hint for a Rainforest Setup Intent. The browser uses the returned
 * trio (`payment_method_config_id`, `session_key`, `allowed_methods`) to
 * render Rainforest's `<rainforest-payment>` web component, which tokenizes
 * the card / ACH details directly to Rainforest (PCI scope stays out of our
 * infrastructure).
 *
 * If we had to lazily create the Hint patient, we re-mint the regToken so the
 * client can persist the new `hintPatientId` for subsequent steps.
 *
 * Reference:
 *   - Hint:       https://developers.hint.com/docs/collecting-payment-information-hint-payments
 *   - Rainforest: https://docs.rainforestpay.com/docs/store-payment-methods-via-component
 */

import { NextRequest, NextResponse } from "next/server";

import { captureServerException } from "@/lib/capture-exception";
import {
  HintApiError,
  createPaymentMethodSetup,
} from "@/lib/hint/client";
import {
  isVerifiedRegistration,
  requireRegistrationToken,
} from "@/lib/auth/registration-session";
import { withPortalErrors } from "@/lib/portal/api";
import { ensureHintPatient } from "@/lib/portal/hint-patient";
import { membershipDisabledResponse } from "@/lib/portal/membership-guard";

export async function POST(request: NextRequest) {
  const disabled = membershipDisabledResponse();
  if (disabled) return disabled;
  return withPortalErrors("register-membership-payment-setup", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const ensured = await ensureHintPatient(
      session,
      "register-membership-payment-setup"
    );
    if (!ensured.ok) return ensured.response;

    // Non-prod (preview / dev) skips Rainforest entirely. The sandbox bundle
    // pulls in Plaid, which throws `SecurityError: Failed to set the 'cookie'
    // property on 'Document'` from inside its sandboxed iframe and leaves
    // `submit()` as a silent no-op — making preview testing impossible. We
    // still call `ensureHintPatient` above so the Hint side of the enrollment
    // is real; the client handles the missing payment widget by showing a
    // sandbox notice and forwarding the CTA straight to /membership with
    // `skipPaymentCheck`.
    const mockMode = process.env.VERCEL_ENV !== "production";
    if (mockMode) {
      return NextResponse.json({
        mockMode: true,
        setup: null,
        bundle: "",
        hintPatientId: ensured.hintPatientId,
        regToken: ensured.refreshedRegToken,
      });
    }

    try {
      const setup = await createPaymentMethodSetup(ensured.hintPatientId, {
        accepts_bank: true,
        user_is_owner: true,
      });

      return NextResponse.json({
        mockMode: false,
        setup,
        hintPatientId: ensured.hintPatientId,
        regToken: ensured.refreshedRegToken,
        bundle: "https://static.rainforestpay.com/payment.js",
      });
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-membership-payment-setup",
          step: "createPaymentMethodSetup",
        },
      });
      if (err instanceof HintApiError) {
        return NextResponse.json(
          {
            error: "Failed to start payment setup",
            code: "HINT_PAYMENT_SETUP",
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
        { error: "Failed to start payment setup" },
        { status: 500 }
      );
    }
  });
}
