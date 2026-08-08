/**
 * POST /api/portal/schedule-link/resolve
 *
 * Server-to-server lookup for other applications that need to resolve an
 * opaque schedule-link token to patient/context claims without embedding
 * patient ids in URLs.
 *
 * Auth: same shared-secret handshake as /mint (HMAC or X-Schedule-Link-Key).
 *
 * Request body: { token: string }
 *
 * Response: {
 *   ok: true,
 *   token,
 *   status: "active" | "used" | "revoked",
 *   expiresAt,
 *   athenaPatientId,
 *   salesforceAccountId?,
 *   departmentId?,
 *   firstName?,
 *   createdAt,
 *   usedAt?
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { withPortalErrors } from "@/lib/portal/api";
import {
  verifyMintCaller,
  shouldEnforceMintAuth,
} from "@/lib/scheduling/schedule-link-auth";
import { getScheduleLinkRecord } from "@/lib/scheduling/schedule-link-records";
import { looksLikeJwt } from "@/lib/scheduling/schedule-link-session";
import {
  ScheduleLinkTokenError,
  verifyScheduleLinkToken,
} from "@/lib/auth/schedule-link-token";
import { getLinkState } from "@/lib/scheduling/schedule-link-store";

interface ResolveBody {
  token?: string;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("schedule-link-resolve", async () => {
    const rawBody = await request.text();

    const verify = verifyMintCaller(rawBody, request.headers);
    if (!verify.ok && shouldEnforceMintAuth()) {
      return NextResponse.json(
        { ok: false, code: "SCHEDULE_LINK_UNAUTHORIZED", error: "Unauthorized" },
        { status: 401 }
      );
    }

    let body: ResolveBody | null = null;
    try {
      body = rawBody.trim() ? (JSON.parse(rawBody) as ResolveBody) : null;
    } catch {
      body = null;
    }

    const token = body?.token?.trim() ?? "";
    if (!token) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", error: "token is required" },
        { status: 400 }
      );
    }

    // Legacy JWT: verify signature and surface claims (no Supabase row).
    if (looksLikeJwt(token)) {
      try {
        const claims = await verifyScheduleLinkToken(token);
        const redisState = await getLinkState(claims.jti);
        const status =
          redisState === "used"
            ? "used"
            : redisState === "missing"
              ? "revoked"
              : "active";
        return NextResponse.json({
          ok: true,
          token: claims.jti,
          legacyJwt: true,
          status,
          expiresAt: claims.exp,
          createdAt: claims.iat,
          athenaPatientId: claims.athenaPatientId,
          salesforceAccountId: claims.salesforceAccountId,
          departmentId: claims.departmentId,
          firstName: claims.firstName,
        });
      } catch (err) {
        if (err instanceof ScheduleLinkTokenError && err.reason === "expired") {
          return NextResponse.json(
            {
              ok: false,
              code: "SCHEDULE_LINK_EXPIRED",
              error: "Schedule link expired",
            },
            { status: 410 }
          );
        }
        return NextResponse.json(
          {
            ok: false,
            code: "SCHEDULE_LINK_INVALID",
            error: "Schedule link not found",
          },
          { status: 404 }
        );
      }
    }

    const record = await getScheduleLinkRecord(token);
    if (!record) {
      return NextResponse.json(
        {
          ok: false,
          code: "SCHEDULE_LINK_INVALID",
          error: "Schedule link not found",
        },
        { status: 404 }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.expiresAt <= now && record.status === "active") {
      return NextResponse.json(
        {
          ok: false,
          code: "SCHEDULE_LINK_EXPIRED",
          error: "Schedule link expired",
          token: record.token,
          status: record.status,
          expiresAt: record.expiresAt,
        },
        { status: 410 }
      );
    }

    return NextResponse.json({
      ok: true,
      token: record.token,
      status: record.status,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      usedAt: record.usedAt,
      athenaPatientId: record.athenaPatientId,
      salesforceAccountId: record.salesforceAccountId,
      departmentId: record.departmentId,
      firstName: record.firstName,
      // phone intentionally omitted from resolve — audit-only at mint time
    });
  });
}
