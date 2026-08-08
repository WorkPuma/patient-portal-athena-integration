import type { Metadata } from "next";
import { CancelMembership } from "@/components/portal/membership/CancelMembership";

export const metadata: Metadata = {
  title: "Cancel Membership",
};

export default function CancelPage() {
  return <CancelMembership />;
}
