/**
 * POST /api/portal/register/claim/send
 *
 * After a successful no-account registration + booking, send the registrant
 * an email and/or SMS with a magic link they can use to create an account
 * later (claim flow). The link carries a single-use claimToken (a regToken
 * with audience pinned to "portal-register" already does the job, but we
 * shorten the TTL to 7 days so users have time to claim from another device).
 *
 * The link target is /register/create-account?claim=<token>. The Clerk sign-up
 * page then carries the token into Clerk's `unsafeMetadata` so the webhook
 * can finalize the link to the existing Athena/Hint patient.
 *
 * Always rate-limited (max 3 sends per regToken in 1 hour) to prevent abuse
 * of our SMS/email allowance.
 */

import { NextRequest, NextResponse } from "next/server";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import { mintRegistrationToken } from "@/lib/auth/registration-token";
import { rateLimit } from "@/lib/rate-limit";
import { withPortalErrors, parseJsonBody } from "@/lib/portal/api";
import { queueSendEmail } from "@/lib/upstash/queue";

interface ClaimSendPayload {
  channels?: ("email" | "sms")[];
  /** App base URL for the claim link. Optional — falls back to envs. */
  baseUrl?: string;
}

const CLAIM_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function buildBaseUrl(payloadUrl?: string): string {
  if (payloadUrl && /^https?:\/\//i.test(payloadUrl)) return payloadUrl.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_PORTAL_URL) return process.env.NEXT_PUBLIC_PORTAL_URL.replace(/\/$/, "");
  if (process.env.PORTAL_REDIRECT_URL) return process.env.PORTAL_REDIRECT_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  return "https://my.example-patient-portal.com";
}

function emailHtml(firstName: string, claimUrl: string): string {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
      <h1 style="font-size:20px;margin:0 0 16px">${greeting}</h1>
      <p>Your visit is booked &mdash; thank you for joining Herself Health!</p>
      <p>Set up your account to manage your appointments, message your care team, and view your membership any time.</p>
      <p style="margin:32px 0">
        <a href="${claimUrl}"
           style="background:#9A0080;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">
          Create my account
        </a>
      </p>
      <p style="font-size:12px;color:#666">This link is good for 7 days. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("register-claim-send", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const rl = await rateLimit(request, {
      limit: 3,
      window: "1h",
      prefix: `portal-register-claim:${session.athenaPatientId}`,
      failClosed: true,
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many claim-link requests. Please wait an hour." },
        { status: 429 }
      );
    }

    const body = (await parseJsonBody<ClaimSendPayload>(request)) ?? {};
    const channels = (body.channels?.length ? body.channels : ["email"]).slice(0, 2);

    const claimToken = await mintRegistrationToken(
      {
        athenaPatientId: session.athenaPatientId,
        hintPatientId: session.hintPatientId,
        departmentId: session.departmentId,
        dobHash: session.dobHash,
        phone: session.phone,
        email: session.email,
        firstName: session.firstName,
        lastName: session.lastName,
      },
      CLAIM_TTL_SECONDS
    );

    const claimUrl = `${buildBaseUrl(body.baseUrl)}/register/create-account?claim=${encodeURIComponent(claimToken)}`;

    const sent: { email?: boolean; sms?: boolean } = {};

    if (channels.includes("email") && session.email) {
      try {
        await queueSendEmail({
          to: session.email,
          subject: "Set up your Herself Health account",
          html: emailHtml(session.firstName || "", claimUrl),
        });
        sent.email = true;
      } catch (err) {
        captureServerException(err, {
          tags: {
            portal_route: "register-claim-send",
            channel: "email",
            severity: "non_fatal",
          },
        });
      }
    }

    if (channels.includes("sms") && session.phone) {
      // SMS is intentionally a soft TODO right now: the Retell start-sms route
      // expects an established Athena patient and a different conversation
      // type. We log instead of crashing so the user still gets the email
      // pathway and we can wire SMS up after product confirms copy/AB tone.
      sent.sms = false;
      captureServerMessage(
        "[register-claim-send] SMS channel requested but not yet wired",
        { level: "info" }
      );
    }

    return NextResponse.json({ sent, claimUrlForDebug: process.env.NODE_ENV === "development" ? claimUrl : undefined });
  });
}
