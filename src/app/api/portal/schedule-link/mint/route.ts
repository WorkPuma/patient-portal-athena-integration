/**
 * POST /api/portal/schedule-link/mint
 *
 * Server-to-server endpoint called by Salesforce (or other apps, after they
 * have verified the patient) to obtain a one-time opaque scheduling link to
 * text the patient. Callers send the SMS; we only mint + register the link.
 *
 * Auth: shared-secret handshake (HMAC over body, or static key header) —
 * see schedule-link-auth.ts. NOT a Clerk session (declared in
 * middleware.ts PORTAL_API_SELF_VERIFY_PREFIXES).
 *
 * Request body:
 *   {
 *     athenaPatientId: string,       // required
 *     salesforceAccountId?: string,  // for tier/eligibility + write-back
 *     departmentId?: number,         // default clinic
 *     phone?: string,                // audit only
 *     firstName?: string,            // greeting only
 *     ttlSeconds?: number,           // optional override (capped)
 *     createdBy?: string             // optional caller label for audit
 *   }
 *
 * Response: { ok: true, url, expiresAt, token, jti }
 *   `jti` is an alias of `token` for older Salesforce callers.
 */

import { NextRequest, NextResponse } from "next/server";
import { withPortalErrors } from "@/lib/portal/api";
import {
  verifyMintCaller,
  shouldEnforceMintAuth,
} from "@/lib/scheduling/schedule-link-auth";
import { SCHEDULE_LINK_DEFAULT_TTL_SECONDS } from "@/lib/auth/schedule-link-token";
import { createScheduleLink } from "@/lib/scheduling/schedule-link-store";

interface MintBody {
  athenaPatientId?: string | number;
  salesforceAccountId?: string;
  departmentId?: number | string;
  phone?: string;
  firstName?: string;
  ttlSeconds?: number;
  createdBy?: string;
}

/** Hard cap so a caller can't mint a near-permanent link. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Resolve the public origin for the link. Prefer an explicit env so the SMS
 * always points at the patient-facing portal host (my.staging... /
 * my.example-patient-portal.com) rather than an internal Vercel URL. Falls back to
 * the request host.
 */
function resolveBaseUrl(request: NextRequest): string {
  const configured = process.env.SCHEDULE_LINK_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const host = request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (host && host.includes("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : "https://my.example-patient-portal.com";
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-mint", async () => {
    const rawBody = await request.text();

    const verify = verifyMintCaller(rawBody, request.headers);
    if (!verify.ok && shouldEnforceMintAuth()) {
      return NextResponse.json(
        { ok: false, code: "SCHEDULE_LINK_UNAUTHORIZED", error: "Unauthorized" },
        { status: 401 }
      );
    }

    let body: MintBody | null = null;
    try {
      body = rawBody.trim() ? (JSON.parse(rawBody) as MintBody) : null;
    } catch {
      body = null;
    }
    if (!body) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", error: "Invalid request body" },
        { status: 400 }
      );
    }

    const athenaPatientId =
      body.athenaPatientId != null ? String(body.athenaPatientId).trim() : "";
    if (!athenaPatientId) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", error: "athenaPatientId is required" },
        { status: 400 }
      );
    }

    const departmentId =
      body.departmentId != null && String(body.departmentId).trim() !== ""
        ? Number(body.departmentId)
        : undefined;

    const ttlSeconds = Math.min(
      MAX_TTL_SECONDS,
      Math.max(
        MIN_TTL_SECONDS,
        Number.isFinite(body.ttlSeconds)
          ? Number(body.ttlSeconds)
          : SCHEDULE_LINK_DEFAULT_TTL_SECONDS
      )
    );

    const created = await createScheduleLink({
      athenaPatientId,
      salesforceAccountId: body.salesforceAccountId,
      departmentId: Number.isFinite(departmentId) ? departmentId : undefined,
      phone: body.phone,
      firstName: body.firstName,
      ttlSeconds,
      createdBy: body.createdBy?.trim() || "mint",
    });

    if (!created) {
      return NextResponse.json(
        {
          ok: false,
          code: "SCHEDULE_LINK_STORE_UNAVAILABLE",
          error: "Could not issue link; please retry.",
        },
        { status: 503 }
      );
    }

    const base = resolveBaseUrl(request);
    const url = `${base}/schedule?t=${encodeURIComponent(created.token)}`;

    return NextResponse.json({
      ok: true,
      url,
      expiresAt: created.expiresAt,
      token: created.token,
      // Alias for older Salesforce callers that expected a JWT jti.
      jti: created.token,
    });
  });
}
