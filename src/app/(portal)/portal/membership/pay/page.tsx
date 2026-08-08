import type { Metadata } from "next";
import { Suspense } from "react";
import { PayInvoice } from "@/components/portal/membership/PayInvoice";

export const metadata: Metadata = {
  title: "Pay Invoice",
};

export default function PayPage() {
  return (
    <Suspense>
      <PayInvoice />
    </Suspense>
  );
}
