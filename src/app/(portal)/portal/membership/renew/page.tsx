import type { Metadata } from "next";
import { RenewContract } from "@/components/portal/membership/RenewContract";

export const metadata: Metadata = {
  title: "Renew Membership",
};

export default function RenewPage() {
  return <RenewContract />;
}
