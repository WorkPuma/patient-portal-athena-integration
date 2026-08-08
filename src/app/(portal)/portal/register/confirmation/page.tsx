import type { Metadata } from "next";
import { RegistrationConfirmation } from "@/components/portal/registration/RegistrationConfirmation";

export const metadata: Metadata = {
  title: "You're all set",
};

export default function ConfirmationPage() {
  return <RegistrationConfirmation />;
}
