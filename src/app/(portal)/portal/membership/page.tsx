import type { Metadata } from "next";
import { MembershipOverview } from "@/components/portal/membership/MembershipOverview";

export const metadata: Metadata = {
  title: "Membership",
};

export default function MembershipPage() {
  return <MembershipOverview />;
}
