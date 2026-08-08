import type { Metadata } from "next";
import { AppointmentList } from "@/components/portal/appointments/AppointmentList";

export const metadata: Metadata = {
  title: "Appointments",
};

export default function AppointmentsPage() {
  return <AppointmentList />;
}
