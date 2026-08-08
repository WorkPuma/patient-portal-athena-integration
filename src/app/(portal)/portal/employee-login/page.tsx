import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { EmployeeLoginForm } from "@/components/admin/EmployeeLoginForm";

export const metadata = {
  title: "Employee Login",
  robots: { index: false, follow: false },
};

export default function EmployeeLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <EmployeeLoginForm />
    </Suspense>
  );
}
