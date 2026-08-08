import type { Metadata } from "next";
import { AppointmentDetail } from "@/components/portal/appointments/AppointmentDetail";

export const metadata: Metadata = {
  title: "Appointment Details",
};

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AppointmentDetail appointmentId={id} />;
}
