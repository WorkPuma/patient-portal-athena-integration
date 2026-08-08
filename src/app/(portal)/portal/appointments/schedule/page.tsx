import type { Metadata } from "next";
import { Suspense } from "react";
import { AppointmentSchedulerPage } from "@/components/portal/appointments/AppointmentScheduler";

export const metadata: Metadata = {
  title: "Schedule Appointment",
};

export default function ScheduleAppointmentPage() {
  return (
    <Suspense>
      <AppointmentSchedulerPage />
    </Suspense>
  );
}
