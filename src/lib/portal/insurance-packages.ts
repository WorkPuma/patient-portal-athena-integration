/**
 * Server-side helpers for the staged portal_insurance_packages Supabase table.
 *
 * The patient portal's no-account registration flow used to call Athena's
 * /insurancepackages endpoint live (flaky, occasional 502s in preview, no way
 * to derive the government-funded flag). We now read from this table instead,
 * which is hydrated daily by the Prefect deployment `portal-insurance-sync`
 * (flow: `prefect-jobs/portal_insurance_sync.py` in the `prefect` repo) and
 * can also be refreshed ad-hoc via `npm run sync:portal-insurance`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";

export interface PortalInsurancePackage {
  insurancepackageid: number;
  insuranceplanname: string;
  payorBrand: string | null;
  payerName: string | null;
  insuranceProductType: string | null;
  insuranceProductTypeId: string | null;
  ediPayerId: string | null;
  governmentFundedType: string | null;
  isGovernmentFunded: boolean;
}

interface PortalInsurancePackageRow {
  insurance_package_id: number;
  insurance_package_name: string;
  payer_name: string | null;
  payor_brand: string | null;
  insurance_product_type: string | null;
  insurance_product_type_id: string | null;
  edi_payer_id: string | null;
  government_funded_type: string | null;
  is_government_funded: boolean;
}

const PORTAL_PKG_COLUMNS =
  "insurance_package_id, insurance_package_name, payer_name, payor_brand, " +
  "insurance_product_type, insurance_product_type_id, edi_payer_id, " +
  "government_funded_type, is_government_funded";

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;
  // Service role lets us read regardless of RLS, but the table also has an
  // anon-read policy so the anon key works too. Prefer service role on the
  // server because the rest of the portal already does.
  // `readSupabaseEnv` strips the `vercel env pull` `\r\n` artifact.
  const env = readSupabaseEnv({ role: "service-role-or-anon" });
  if (!env) return null;
  supabase = createClient(env.url, env.key, {
    db: { schema: "public" },
    auth: { persistSession: false },
  });
  return supabase;
}

function rowToPackage(row: PortalInsurancePackageRow): PortalInsurancePackage {
  return {
    insurancepackageid: row.insurance_package_id,
    insuranceplanname: row.insurance_package_name,
    payorBrand: row.payor_brand,
    payerName: row.payer_name,
    insuranceProductType: row.insurance_product_type,
    insuranceProductTypeId: row.insurance_product_type_id,
    ediPayerId: row.edi_payer_id,
    governmentFundedType: row.government_funded_type,
    isGovernmentFunded: !!row.is_government_funded,
  };
}

// Some payers route eligibility (270/271) through a single gateway EDI but
// submit claims under different EMCCODEs per subsidiary. Athena's
// `EMCCODE` (mirrored to `edi_payer_id`) reflects the *claims-submission*
// payer id, while Stedi 271 returns the *eligibility-gateway* id. So when
// a patient's UMR card is verified through the UHC gateway (87726), the
// 271 says 87726 but the right Athena package (149947 UMR) is keyed under
// 39026. Without aliasing, the lookup would never see UMR or Surest
// candidates for that 271.
//
// Map keys are gateway EDI ids that Stedi 271 may return; values are
// every EMCCODE we should also consider as candidate packages.
//
// Stedi 271 evidence: probe-stedi-raw.json (2026-04-25) — UMR & Surest
// patients both come back with `payer.payorIdentification = "87726"`.
const EDI_GATEWAY_ALIASES: Record<string, string[]> = {
  // UnitedHealthcare gateway → also include UMR (39026) and Surest (25463).
  "87726": ["87726", "39026", "25463"],
};

/**
 * Look up all active portal insurance packages whose `edi_payer_id` (sourced
 * from Athena's EMCCODE — same X12 identifier Stedi returns as
 * `payer.payorIdentification` on the 271) matches the given value, plus any
 * EMCCODEs aliased through the same eligibility gateway.
 *
 * Many Athena packages share the same edi_payer_id (e.g. all 13 BCBS-MN
 * packages share `00720`). Caller (typically the Stedi package resolver)
 * is responsible for picking the right one by `insuranceProductTypeId` /
 * `governmentFundedType` once the brand-level match has narrowed.
 */
export async function lookupPortalInsuranceByEdiPayerId(
  ediPayerId: string
): Promise<PortalInsurancePackage[]> {
  const trimmed = ediPayerId.trim();
  if (!trimmed) return [];

  const client = getClient();
  if (!client) {
    throw new Error(
      "Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)."
    );
  }

  const ediCandidates = EDI_GATEWAY_ALIASES[trimmed] ?? [trimmed];

  const { data, error } = await client
    .from("portal_insurance_packages")
    .select(PORTAL_PKG_COLUMNS)
    .eq("is_active", true)
    .in("edi_payer_id", ediCandidates)
    .order("patient_insurance_count", { ascending: false })
    .order("insurance_package_id", { ascending: true });

  if (error) {
    throw new Error(
      `portal_insurance_packages lookup by edi_payer_id failed: ${error.message}`
    );
  }
  return (data || []).map((r) =>
    rowToPackage(r as unknown as PortalInsurancePackageRow)
  );
}

/**
 * Typeahead search for insurance packages by plan name or payer name.
 * Case-insensitive substring match. Returns up to `limit` active rows,
 * ordered by patient_insurance_count desc (most-used first) then name asc
 * so common Minnesota plans float to the top.
 */
export async function searchPortalInsurancePackages(
  query: string,
  limit = 25
): Promise<PortalInsurancePackage[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const client = getClient();
  if (!client) {
    throw new Error(
      "Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)."
    );
  }

  // Escape Postgres LIKE wildcards in the user input so a query like "100%"
  // doesn't blow up the result set.
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;

  const { data, error } = await client
    .from("portal_insurance_packages")
    .select(PORTAL_PKG_COLUMNS)
    .eq("is_active", true)
    .or(
      `insurance_package_name.ilike.${pattern},payer_name.ilike.${pattern},payor_brand.ilike.${pattern}`
    )
    .order("patient_insurance_count", { ascending: false })
    .order("insurance_package_name", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`portal_insurance_packages search failed: ${error.message}`);
  }

  return (data || []).map((r) =>
    rowToPackage(r as unknown as PortalInsurancePackageRow)
  );
}

// ─── Preview environment remap ───────────────────────────────────────────
//
// The `portal_insurance_packages` table carries **production** Athena
// `insurancepackageid`s (that's what MDM is tracking). Athena preview has its
// own distinct /insurancepackages registry — almost none of the prod ids exist
// there, so POST /patients/{id}/insurances in preview reliably returns
//   400 "The insurancepackageid is not valid."
// which is what we were seeing on my.example-patient-portal.com (preview deploy).
//
// Fix: in the preview environment, remap whatever the patient picked to a
// known-good package that *does* exist in Athena preview. We use BCBS-MN
// (id 1132) because:
//   - it resolves cleanly in preview (verified via
//     scripts/probe-athena-preview-insurance.ts), and
//   - it's the same fallback the midi/CCDA Prefect flow uses when MDM lookup
//     misses (see prefect/.../flows/shared/patient_ops.py BCBS_MN_FALLBACK_ID).
// Overridable via PORTAL_PREVIEW_INSURANCE_PACKAGE_ID if Athena rotates it.
//
// Production: unconditional pass-through of the MDM-sourced id.
const DEFAULT_PREVIEW_INSURANCE_PACKAGE_ID = 1132; // BCBS-MN in Athena preview

/**
 * Return the Athena `insurancepackageid` that should actually be written to
 * the patient record. In preview, this is the hard-coded BCBS-MN stand-in.
 * In production, this is the caller-supplied id unchanged.
 *
 * We detect preview via ATHENA_BASE_URL (the most authoritative signal — it's
 * the actual Athena tenant we're about to call) with VERCEL_ENV as a backstop.
 */
export function resolveAthenaInsurancePackageId(requestedId: number): {
  effectiveId: number;
  remapped: boolean;
  reason: string | null;
} {
  const athenaHost = (process.env.ATHENA_BASE_URL || "").toLowerCase();
  const isAthenaPreview = athenaHost.includes("preview");
  const isVercelPreview = process.env.VERCEL_ENV === "preview";
  const shouldRemap = isAthenaPreview || isVercelPreview;

  if (!shouldRemap) {
    return { effectiveId: requestedId, remapped: false, reason: null };
  }

  const override = Number.parseInt(
    process.env.PORTAL_PREVIEW_INSURANCE_PACKAGE_ID || "",
    10
  );
  const previewId =
    Number.isFinite(override) && override > 0
      ? override
      : DEFAULT_PREVIEW_INSURANCE_PACKAGE_ID;

  if (requestedId === previewId) {
    return { effectiveId: previewId, remapped: false, reason: null };
  }

  return {
    effectiveId: previewId,
    remapped: true,
    reason: isAthenaPreview
      ? "athena-preview-host"
      : "vercel-preview-env",
  };
}

/** Fetch a single package by Athena package id; returns null when missing. */
export async function getPortalInsurancePackageById(
  insurancePackageId: number
): Promise<PortalInsurancePackage | null> {
  const client = getClient();
  if (!client) return null;
  const { data, error } = await client
    .from("portal_insurance_packages")
    .select(
      "insurance_package_id, insurance_package_name, payer_name, payor_brand, insurance_product_type, government_funded_type, is_government_funded"
    )
    .eq("insurance_package_id", insurancePackageId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToPackage(data as PortalInsurancePackageRow);
}
