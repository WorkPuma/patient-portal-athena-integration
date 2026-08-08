import type { Metadata } from "next";
import { Suspense } from "react";
import { InitialVisitScheduler } from "@/components/portal/registration/InitialVisitScheduler";

export const metadata: Metadata = {
  title: "Schedule Your First Visit",
};

export default function SchedulePage() {
  return (
    <Suspense>
      <InitialVisitScheduler />
    </Suspense>
  );
}
