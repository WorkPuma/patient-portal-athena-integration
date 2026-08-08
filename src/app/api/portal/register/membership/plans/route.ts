/**
 * GET /api/portal/register/membership/plans
 *
 * Public list of HINT membership plans available for self-service enrollment.
 * 5-minute Redis cache keeps this hot without hammering the Hint API.
 *
 * NOTES on Hint Connect API quirks (verified 2026-04-18 against api.hint.com):
 *  - GET /api/provider/plans returns ONLY {id, name, plan_type}. No pricing,
 *    no interval. GET /api/provider/plans/{id} returns 403 with our practice
 *    sync key, so we cannot fetch pricing dynamically.
 *  - We therefore enrich each plan locally from PLAN_CATALOG (keyed by Hint
 *    plan id). Plans Hint returns that aren't in the catalog are still surfaced
 *    so the UI sees them, but with amount_cents=0 + interval="" so the wizard
 *    can decide how to render them.
 *  - The "Herself Legacy Member" SKU is a closed/legacy plan and must NOT be
 *    offered through the self-service portal.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPlans } from "@/lib/hint/client";
import { rateLimit } from "@/lib/rate-limit";
import { cacheGet, cacheSet } from "@/lib/upstash/cache";
import { withPortalErrors } from "@/lib/portal/api";
import { membershipDisabledResponse } from "@/lib/portal/membership-guard";
import { captureServerException } from "@/lib/capture-exception";

const CACHE_KEY = "register:hint-plans:v3";
const CACHE_TTL = 300;

interface PlanShape {
  id: string;
  name: string;
  amount_cents: number;
  interval: string;
  description?: string;
}

// Hint plan ids that should never be shown to a self-service registrant.
// We list both prod and sandbox legacy ids so the same code works in both.
const EXCLUDED_PLAN_IDS = new Set<string>([
  "pln-37OTsn3VnHfO", // PROD: Herself Legacy Member
  "pln-Juk7zVu38sT6", // SANDBOX: Legacy Membership
]);

// Defensive name-based filter in case the practice renames/relinks the plan.
const EXCLUDED_NAME_KEYWORDS = ["legacy"];

// Pricing catalog keyed by Hint plan id. Update here when new plans are
// created in the Hint admin UI (Settings → Plans). period_rate_in_cents and
// period_in_months from GET /api/provider/memberships are the source of truth
// for any value below.
const PLAN_CATALOG: Record<
  string,
  {
    name?: string;
    amount_cents: number;
    interval: string;
    description?: string;
    sort: number;
  }
> = {
  // PROD — Her Membership annual ($999.99/yr).
  "pln-7abVK3P2q8n8": {
    name: "Her Membership",
    amount_cents: 99999,
    interval: "year",
    description: "Annual membership — best value.",
    sort: 2,
  },

  // SANDBOX — $99/mo Her Membership (Hint name: "Membership").
  "pln-FXMKDwMz7ixK": {
    name: "Her Membership",
    amount_cents: 9900,
    interval: "month",
    description: "Pay month-to-month. Cancel anytime.",
    sort: 1,
  },

  // TODO(prod): When the $99/mo Her Membership SKU is created in PROD Hint
  // admin, add its `pln-…` id here with the same shape as the sandbox row
  // above so it shows alongside the annual.
  //
  // TODO(sandbox): When the $999/yr Her Membership SKU is created in SANDBOX
  // Hint admin, add its `pln-…` id here with sort: 2, interval: "year",
  // amount_cents: 99900 so the sandbox preview shows both options too.
};

export async function GET(request: NextRequest) {
  const disabled = membershipDisabledResponse();
  if (disabled) return disabled;
  return withPortalErrors("register-membership-plans", async () => {
    const rl = await rateLimit(request, {
      limit: 60,
      window: "1m",
      prefix: "portal-register-plans",
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const cached = await cacheGet<PlanShape[]>(CACHE_KEY, { prefix: "portal" });
    if (cached) {
      return NextResponse.json({ plans: cached, cached: true });
    }

    if (!process.env.HINT_API_KEY) {
      return NextResponse.json({ plans: [], cached: false });
    }

    try {
      const plans = await getPlans();

      const filtered = plans.filter((p) => {
        if (EXCLUDED_PLAN_IDS.has(p.id)) return false;
        const name = (p.name || "").toLowerCase();
        return !EXCLUDED_NAME_KEYWORDS.some((kw) => name.includes(kw));
      });

      const enriched: PlanShape[] = filtered.map((p) => {
        const catalog = PLAN_CATALOG[p.id];
        return {
          id: p.id,
          name: catalog?.name ?? p.name,
          amount_cents: catalog?.amount_cents ?? p.amount_cents ?? 0,
          interval: catalog?.interval ?? p.interval ?? "",
          description: catalog?.description ?? p.description,
        };
      });

      enriched.sort((a, b) => {
        const sa = PLAN_CATALOG[a.id]?.sort ?? 99;
        const sb = PLAN_CATALOG[b.id]?.sort ?? 99;
        return sa - sb;
      });

      await cacheSet(CACHE_KEY, enriched, {
        prefix: "portal",
        ttl: CACHE_TTL,
      });
      return NextResponse.json({ plans: enriched, cached: false });
    } catch (err) {
      captureServerException(err, {
        tags: { portal_route: "register-membership-plans" },
      });
      return NextResponse.json(
        { error: "Failed to load membership plans" },
        { status: 502 }
      );
    }
  });
}
