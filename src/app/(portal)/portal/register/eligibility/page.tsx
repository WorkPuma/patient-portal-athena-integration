import type { Metadata } from "next";
import { Suspense } from "react";
import { EligibilityCheck } from "@/components/portal/registration/EligibilityCheck";
import { EligibilityCheckBrand } from "@/components/portal/registration/EligibilityCheckBrand";

export const metadata: Metadata = {
  title: "Insurance Eligibility",
};

/**
 * Picks between the curated brand-card flow (Stedi-driven, DEV-3961) and the
 * legacy Athena-package autocomplete behind a single env flag. Reading the
 * flag at the page level keeps both component trees independent — rolling
 * back is a one-line Vercel env change with zero code redeploys.
 */
function isStediFlowEnabled(): boolean {
  return /^(1|true|yes)$/i.test(
    process.env.NEXT_PUBLIC_ENABLE_STEDI_ELIGIBILITY ?? ""
  );
}

export default function EligibilityPage() {
  const useBrandFlow = isStediFlowEnabled();
  return (
    <Suspense>
      {useBrandFlow ? <EligibilityCheckBrand /> : <EligibilityCheck />}
    </Suspense>
  );
}
