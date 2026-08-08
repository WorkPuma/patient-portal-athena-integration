"use client";

import {
  ArrowLeft,
  Calendar,
  Clock,
  MapPin,
  User,
  Video,
  Building2,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { VisitModality } from "@/lib/scheduling/appointment-types";
import { getAppointmentTypeById } from "@/lib/scheduling/appointment-types";

interface ConfirmStepProps {
  appointmentTypeId: number;
  modality: VisitModality;
  slotDate: string;
  slotTime: string;
  slotDuration: number;
  providerName: string;
  locationName: string;
  booking: boolean;
  booked: boolean;
  error: string;
  onConfirm: () => void;
  onBack: () => void;
  onDone: () => void;
}

export function ConfirmStep({
  appointmentTypeId,
  modality,
  slotDate,
  slotTime,
  slotDuration,
  providerName,
  locationName,
  booking,
  booked,
  error,
  onConfirm,
  onBack,
  onDone,
}: ConfirmStepProps) {
  const appointmentType = getAppointmentTypeById(appointmentTypeId);

  function formatDate(dateStr: string): string {
    const [month, day, year] = dateStr.split("/").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  if (booked) {
    return (
      <div className="py-8 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600 dark:text-emerald-500" />
        <h3 className="mb-2 text-lg font-medium">Appointment Booked!</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          {appointmentType?.displayName || "Appointment"} on {formatDate(slotDate)} at{" "}
          {slotTime}
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          You&apos;ll receive a confirmation shortly.
        </p>
        <Button onClick={onDone}>View Appointments</Button>
      </div>
    );
  }

  const ModalityIcon = modality === "telehealth" ? Video : Building2;

  return (
    <div className="space-y-4">
      <Button
        variant="link"
        className="h-auto gap-1 p-0 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>

      <div>
        <h3 className="text-base font-medium">Confirm Your Appointment</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Review the details below before booking.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">
              {appointmentType?.displayName || "Appointment"}
            </h4>
            <Badge variant="outline" className="gap-1">
              <ModalityIcon className="h-3 w-3" />
              {modality === "telehealth" ? "Telehealth" : "In-Person"}
            </Badge>
          </div>

          <Separator />

          <div className="grid gap-3 text-sm">
            <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>{formatDate(slotDate)}</span>
            </div>
            <div className="flex items-center gap-3">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>
                {slotTime} &middot; {slotDuration} minutes
              </span>
            </div>
            <div className="flex items-center gap-3">
              <User className="h-4 w-4 text-muted-foreground" />
              <span>{providerName || "Any available provider"}</span>
            </div>
            <div className="flex items-center gap-3">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>{locationName || "Herself Health Clinic"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end pt-2">
        <Button onClick={onConfirm} disabled={booking} className="gap-2">
          {booking ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Booking...
            </>
          ) : (
            "Confirm Booking"
          )}
        </Button>
      </div>
    </div>
  );
}
