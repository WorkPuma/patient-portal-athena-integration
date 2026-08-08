"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SchedulingWizard } from "./SchedulingWizard";

interface AppointmentSchedulerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rescheduleId?: string;
}

export function AppointmentScheduler({
  open,
  onOpenChange,
  rescheduleId,
}: AppointmentSchedulerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">
            {rescheduleId ? "Reschedule Appointment" : "Schedule Appointment"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <SchedulingWizard
            rescheduleId={rescheduleId}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AppointmentSchedulerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rescheduleId = searchParams.get("reschedule") || undefined;

  return (
    <AppointmentScheduler
      open={true}
      onOpenChange={(open) => {
        if (!open) router.push("/appointments");
      }}
      rescheduleId={rescheduleId}
    />
  );
}
