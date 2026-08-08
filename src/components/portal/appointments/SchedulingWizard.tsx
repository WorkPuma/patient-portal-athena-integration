"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { SchedulingHeader } from "./SchedulingHeader";
import { ModalityStep } from "./steps/ModalityStep";
import { VisitReasonStep } from "./steps/VisitReasonStep";
import { CalendarStep, type Slot } from "./steps/CalendarStep";
import { ConfirmStep } from "./steps/ConfirmStep";
import {
  getAppointmentType,
  getInitialVisitTypeId,
  WIZARD_STEPS,
  getStepIndex,
  type WizardStep,
  type WizardState,
  type VisitModality,
  type VisitReason,
  type PortalCategory,
  INITIAL_WIZARD_STATE,
} from "@/lib/scheduling/appointment-types";
import { getMockPatientContext } from "@/lib/scheduling/mock-data";
import type { MockPatientContext } from "@/lib/scheduling/mock-data";
import {
  trackScheduleViewed,
  trackAppointmentBooked,
  trackAppointmentBookFailed,
  type AppointmentBookFailureReason,
} from "@/lib/posthog/events";

interface Department {
  departmentid: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  phone?: string;
}

interface PatientDefaults {
  primaryproviderid: string;
  primarydepartmentid: string;
  departmentName: string;
  departments: Department[];
}

interface SchedulingWizardProps {
  rescheduleId?: string;
  onClose: () => void;
}

export function SchedulingWizard({ rescheduleId, onClose }: SchedulingWizardProps) {
  const router = useRouter();

  const [step, setStep] = useState<WizardStep>("modality");
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [defaults, setDefaults] = useState<PatientDefaults | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [editingLocation, setEditingLocation] = useState(false);

  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookingError, setBookingError] = useState("");

  const [cachedSlots, setCachedSlots] = useState<Slot[]>([]);
  const [patientSeed, setPatientSeed] = useState("demo");

  /** Defaults to false until visit-history loads — that way we never
   *  accidentally show a brand-new patient the chief-complaint picker. */
  const [isEstablished, setIsEstablished] = useState(false);
  const [selectedReasonId, setSelectedReasonId] = useState<number | undefined>(
    undefined
  );
  const [selectedReasonLabel, setSelectedReasonLabel] = useState<
    string | undefined
  >(undefined);

  const mockCtx: MockPatientContext = useMemo(
    () => getMockPatientContext(patientSeed),
    [patientSeed]
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [defaultsRes, sessionRes, historyRes] = await Promise.all([
          fetch("/api/portal/athena/patient/defaults"),
          fetch("/api/portal/auth/session"),
          fetch("/api/portal/athena/patient/visit-history"),
        ]);

        if (historyRes.ok) {
          const history = await historyRes
            .json()
            .catch(() => null as { isEstablished?: boolean } | null);
          if (!cancelled && history && typeof history.isEstablished === "boolean") {
            setIsEstablished(history.isEstablished);
          }
        }

        if (defaultsRes.ok) {
          const data: PatientDefaults = await defaultsRes.json();
          if (cancelled) return;
          setDefaults(data);
          setState((prev) => ({
            ...prev,
            departmentId: data.primarydepartmentid || "",
            providerId: data.primaryproviderid || "",
          }));
        }

        if (sessionRes.ok) {
          const session = await sessionRes.json();
          if (!cancelled && session?.user?.athenaPatientId) {
            setPatientSeed(session.user.athenaPatientId);
          }
        }
      } catch {
        // Fallback: user can still pick from available departments
      } finally {
        if (!cancelled) setLoadingDefaults(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const progressPercent = useMemo(() => {
    const idx = getStepIndex(step);
    return ((idx + 1) / WIZARD_STEPS.length) * 100;
  }, [step]);

  const handleModalitySelect = useCallback((modality: VisitModality) => {
    setState((prev) => ({
      ...prev,
      modality,
      visitReason: null,
      selectedCategory: null,
      appointmentTypeId: null,
      selectedSlotId: null,
    }));
    setStep("visit_reason");
  }, []);

  const handleVisitReasonSelect = useCallback(
    (
      reason: VisitReason,
      category: PortalCategory,
      reasonId?: number,
      reasonLabel?: string
    ) => {
      const modality = state.modality || "in_person";

      // Pick a SINGLE Athena appointmenttypeid to drive both the open-slot
      // query AND the book PUT. Athena auto-expands the typeid into all
      // matching multi-purpose ("Any X") slots — see appointment-types.ts.
      // New / one-visit patients are pinned to the Initial Visit type
      // regardless of which card they tapped; established patients get
      // the dedicated type for the category they chose.
      const dedicatedTypeId = isEstablished
        ? getAppointmentType(category, modality)?.appointmentTypeId ?? null
        : getInitialVisitTypeId(modality);

      setSelectedReasonId(reasonId);
      setSelectedReasonLabel(reasonLabel);

      setState((prev) => ({
        ...prev,
        visitReason: reason,
        selectedCategory: category,
        appointmentTypeId: dedicatedTypeId,
        selectedSlotId: null,
      }));

      // Funnel event: the patient has now committed to a visit type +
      // modality and is about to see the slot grid. Drop the reasonLabel
      // (it's a free-text Athena field) — only the categorical
      // appointmenttypeid + duration go to PostHog.
      if (dedicatedTypeId) {
        const apptType = getAppointmentType(category, modality);
        trackScheduleViewed({
          visitTypeId: dedicatedTypeId,
          durationMinutes: apptType?.duration ?? 0,
          departmentId: state.departmentId
            ? parseInt(state.departmentId, 10)
            : undefined,
        });
      }

      setStep("calendar");
    },
    // `state.departmentId` is read by the trackScheduleViewed call
    // above; without it in deps, switching clinic before selecting a
    // reason would emit the event with a stale department.
    [state.modality, state.departmentId, isEstablished]
  );

  const handleSlotSelect = useCallback((slotId: string) => {
    setState((prev) => ({ ...prev, selectedSlotId: slotId }));
  }, []);

  const handleCalendarConfirm = useCallback(() => {
    setStep("confirm");
  }, []);

  const handleBook = useCallback(async () => {
    if (!state.selectedSlotId) return;
    setBooking(true);
    setBookingError("");

    function classifyBookError(
      status: number,
      data: { code?: string; error?: string } | null,
    ): AppointmentBookFailureReason {
      const code = data?.code?.toUpperCase() ?? "";
      if (code === "ATHENA_SLOT_TAKEN" || status === 409) return "slot_taken";
      if (code === "REGISTRATION_TYPE_NOT_ALLOWED") return "slot_invalid";
      if (code.includes("PATIENT_NOT_FOUND")) return "patient_not_found";
      if (code.includes("PATIENT_INELIGIBLE")) return "patient_ineligible";
      if (code.includes("DUPLICATE")) return "duplicate_appointment";
      if (status >= 500) return "athena_5xx";
      if (status >= 400) return "athena_4xx";
      if (status === 0) return "network_error";
      return "unknown";
    }

    try {
      if (rescheduleId) {
        const res = await fetch(
          `/api/portal/athena/appointments/${rescheduleId}/reschedule`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              newAppointmentId: parseInt(state.selectedSlotId, 10),
            }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          trackAppointmentBookFailed({
            reason: classifyBookError(res.status, data),
            appointmentTypeId: state.appointmentTypeId ?? undefined,
            departmentId: state.departmentId
              ? parseInt(state.departmentId, 10)
              : undefined,
          });
          setBookingError(data?.error || "Reschedule failed");
          return;
        }
      } else {
        // Always book with the SAME typeid we queried slots for. Athena
        // rewrites the underlying slot (dedicated OR multi-purpose
        // "Any X" / synthesized grouping) to that type on PUT — verified
        // end-to-end via scripts/probe-athena-book-flow.ts.
        const body: Record<string, unknown> = {
          appointmentId: parseInt(state.selectedSlotId, 10),
        };
        if (state.appointmentTypeId) {
          body.appointmenttypeid = state.appointmentTypeId;
        }
        if (state.departmentId) {
          body.departmentid = parseInt(state.departmentId, 10);
        }
        if (selectedReasonId) {
          body.reasonid = selectedReasonId;
        }
        if (selectedReasonLabel) {
          body.bookingnote = selectedReasonLabel;
        } else if (!isEstablished) {
          body.bookingnote = "Initial visit - scheduled via patient portal";
        }

        const res = await fetch("/api/portal/athena/appointments/book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          trackAppointmentBookFailed({
            reason: classifyBookError(res.status, data),
            appointmentTypeId: state.appointmentTypeId ?? undefined,
            departmentId: state.departmentId
              ? parseInt(state.departmentId, 10)
              : undefined,
          });
          setBookingError(data?.error || "Booking failed");
          return;
        }

        // Compute daysUntilAppointment from the cached slot — no PHI in
        // the date itself, this is a useful funnel metric for booking
        // lead time.
        const slot = cachedSlots.find(
          (s) => s.appointmentid === state.selectedSlotId,
        );
        let daysUntil = 0;
        if (slot?.date) {
          const parts = slot.date.split("/");
          if (parts.length === 3) {
            const apptDate = new Date(
              Number(parts[2]),
              Number(parts[0]) - 1,
              Number(parts[1]),
            );
            const ms = apptDate.getTime() - Date.now();
            daysUntil = Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
          }
        }
        if (state.appointmentTypeId && state.departmentId) {
          trackAppointmentBooked({
            appointmentId: String(state.selectedSlotId),
            appointmentTypeId: state.appointmentTypeId,
            departmentId: parseInt(state.departmentId, 10),
            daysUntilAppointment: daysUntil,
          });
        }
      }

      setBooked(true);
    } catch {
      trackAppointmentBookFailed({
        reason: "network_error",
        appointmentTypeId: state.appointmentTypeId ?? undefined,
        departmentId: state.departmentId
          ? parseInt(state.departmentId, 10)
          : undefined,
      });
      setBookingError("Network error. Please try again.");
    } finally {
      setBooking(false);
    }
  }, [
    state.selectedSlotId,
    state.appointmentTypeId,
    state.departmentId,
    rescheduleId,
    selectedReasonId,
    selectedReasonLabel,
    isEstablished,
    cachedSlots,
  ]);

  const handleDone = useCallback(() => {
    router.push("/appointments");
    router.refresh();
    onClose();
  }, [router, onClose]);

  const selectedSlotData = cachedSlots.find(
    (s) => s.appointmentid === state.selectedSlotId
  );

  const selectedDept = defaults?.departments.find(
    (d) => d.departmentid === state.departmentId
  );

  const providerName =
    selectedSlotData?.providerfirstname
      ? `Dr. ${selectedSlotData.providerfirstname} ${selectedSlotData.providerlastname || ""}`
      : "";

  if (loadingDefaults) {
    return (
      <div className="space-y-4 py-4">
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Progress value={progressPercent} className="h-1.5" />

      {defaults && defaults.departments.length > 0 && (
        <SchedulingHeader
          departments={defaults.departments}
          selectedDepartmentId={state.departmentId}
          onDepartmentChange={(id) => {
            setState((prev) => ({ ...prev, departmentId: id, selectedSlotId: null }));
          }}
          providerName={providerName}
          editingLocation={editingLocation}
          onToggleLocationEdit={() => setEditingLocation((prev) => !prev)}
        />
      )}

      {step === "modality" && (
        <ModalityStep onSelect={handleModalitySelect} />
      )}

      {step === "visit_reason" && state.modality && (
        <VisitReasonStep
          modality={state.modality}
          mockCtx={mockCtx}
          isEstablished={isEstablished}
          onSelect={handleVisitReasonSelect}
          onBack={() => setStep("modality")}
        />
      )}

      {step === "calendar" &&
        state.modality &&
        state.selectedCategory &&
        state.appointmentTypeId && (
          <CalendarStep
            departmentId={state.departmentId}
            modality={state.modality}
            category={state.selectedCategory}
            appointmentTypeId={state.appointmentTypeId}
            selectedSlotId={state.selectedSlotId}
            onSlotSelect={handleSlotSelect}
            onSlotsLoaded={setCachedSlots}
            onConfirm={handleCalendarConfirm}
            onBack={() => setStep("visit_reason")}
          />
        )}

      {step === "confirm" && state.appointmentTypeId && selectedSlotData && (
        <ConfirmStep
          appointmentTypeId={state.appointmentTypeId}
          modality={state.modality || "in_person"}
          slotDate={selectedSlotData.date}
          slotTime={selectedSlotData.starttime}
          slotDuration={selectedSlotData.duration}
          providerName={providerName}
          locationName={
            selectedDept
              ? `${selectedDept.name}${selectedDept.city ? `, ${selectedDept.city}` : ""}`
              : "Herself Health Clinic"
          }
          booking={booking}
          booked={booked}
          error={bookingError}
          onConfirm={handleBook}
          onBack={() => setStep("calendar")}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
