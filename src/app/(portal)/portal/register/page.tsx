import type { Metadata } from "next";
import { RegistrationWizard } from "@/components/portal/registration/RegistrationWizard";

export const metadata: Metadata = {
  title: "Register",
};

export default function RegisterPage() {
  return <RegistrationWizard />;
}
