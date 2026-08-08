import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { MembershipEnrollment } from "@/components/portal/registration/MembershipEnrollment";
import { getPortalFeatureFlags } from "@/lib/portal/feature-flags";

export const metadata: Metadata = {
  title: "Membership Enrollment",
};

export default function MembershipEnrollPage() {
  // When membership is gated off in the registration funnel, send the user
  // straight to scheduling so a stale link (or a deep-linked browser tab)
  // can't dead-end on the disabled enrollment UI.
  if (!getPortalFeatureFlags().membership) {
    redirect("/register/schedule");
  }
  return (
    <Suspense>
      <MembershipEnrollment />
    </Suspense>
  );
}
