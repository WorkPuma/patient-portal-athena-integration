import type { Metadata } from "next";
import { LoginForm } from "@/components/portal/auth/LoginForm";

export const metadata: Metadata = {
  title: "Sign In | Herself Health Portal",
};

export default function LoginPage() {
  return <LoginForm />;
}
