"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ArrowLeft, Clock, Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import type {
  PortalCategory,
  VisitModality,
} from "@/lib/scheduling/appointment-types";
import { getAppointmentType } from "@/lib/scheduling/appointment-types";

export interface Slot {
  appointmentid: string;
  date: string;
  starttime: string;
  duration: number;
  providerid: string;
  providerfirstname?: string;
  providerlastname?: string;
  appointmenttype?: string;
  appointmenttypeid?: string;
  departmentid?: string;
}

interface CalendarStepProps {
  departmentId: string;
  modality: VisitModality;
  category: PortalCategory;
  /** The single Athena `appointmenttypeid` to query slots for. Athena
   *  auto-expands this into matching multi-purpose ("Any X") slots — see
   *  appointment-types.ts. The same id is used on the book PUT. */
  appointmentTypeId: number;
  selectedSlotId: string | null;
  onSlotSelect: (slotId: string) => void;
  onSlotsLoaded: (slots: Slot[]) => void;
  onConfirm: () => void;
  onBack: () => void;
}

function parseSlotDate(dateStr: string): Date {
  const [month, day, year] = dateStr.split("/").map(Number);
  return new Date(year, month - 1, day);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarStep({
  departmentId,
  modality,
  category,
  appointmentTypeId,
  selectedSlotId,
  onSlotSelect,
  onSlotsLoaded,
  onConfirm,
  onBack,
}: CalendarStepProps) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);

  const appointmentType = getAppointmentType(category, modality);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError("");
    setSlots([]);

    try {
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 30);

      const fmt = (d: Date) =>
        `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

      const params = new URLSearchParams({
        departmentid: departmentId,
        startdate: fmt(today),
        enddate: fmt(endDate),
      });
      if (appointmentTypeId) {
        params.set("appointmenttypeid", String(appointmentTypeId));
      }

      const res = await fetch(
        `/api/portal/athena/appointments/available?${params.toString()}`
      );

      if (res.ok) {
        const data = await res.json();
        const fetched: Slot[] = data.appointments || [];
        setSlots(fetched);
        onSlotsLoaded(fetched);

        if (fetched.length > 0 && !selectedDate) {
          setSelectedDate(parseSlotDate(fetched[0].date));
        }
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || `Failed to load times (${res.status}).`);
      }
    } catch {
      setError("Failed to load available times.");
    } finally {
      setLoading(false);
    }
  }, [departmentId, appointmentTypeId, selectedDate, onSlotsLoaded]);

  useEffect(() => {
     
    fetchSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, appointmentTypeId]);

  const datesWithSlots = useMemo(() => {
    const dates = new Set<string>();
    for (const slot of slots) {
      dates.add(slot.date);
    }
    return dates;
  }, [slots]);

  const slotsForSelectedDate = useMemo(() => {
    if (!selectedDate) return [];
    return slots.filter((s) => isSameDay(parseSlotDate(s.date), selectedDate));
  }, [slots, selectedDate]);

  const selectedSlot = slots.find((s) => s.appointmentid === selectedSlotId);

  function isDayAvailable(date: Date): boolean {
    const fmt = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
    return datesWithSlots.has(fmt);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton className="h-72 rounded-xl" />
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

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
        <h3 className="text-base font-medium">
          Select a Time
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {appointmentType?.displayName || "Appointment"} &middot;{" "}
          {appointmentType?.duration || 40} min
        </p>
      </div>

      {error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={fetchSlots}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : slots.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CalendarIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">
              No available slots in the next 30 days for this visit type.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr]">
            <Card className="w-fit">
              <CardContent className="p-3">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  modifiers={{
                    available: (date) => isDayAvailable(date),
                  }}
                  modifiersClassNames={{
                    available: "font-bold text-primary",
                  }}
                  disabled={(date) => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    return date < today || !isDayAvailable(date);
                  }}
                  className="rounded-md"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {selectedDate
                    ? selectedDate.toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                    : "Select a date"}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {slotsForSelectedDate.length === 0 ? (
                  <p className="px-4 pb-4 text-sm text-muted-foreground">
                    No slots available on this date.
                  </p>
                ) : (
                  <ScrollArea className="h-72 px-4 pb-4">
                    <div className="space-y-2">
                      {slotsForSelectedDate.map((slot) => {
                        const isSelected = selectedSlotId === slot.appointmentid;
                        const provider =
                          slot.providerfirstname
                            ? `Dr. ${slot.providerfirstname} ${slot.providerlastname || ""}`
                            : undefined;

                        return (
                          <button
                            key={slot.appointmentid}
                            type="button"
                            className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${isSelected
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "hover:border-primary/50 hover:bg-muted/50"
                              }`}
                            onClick={() => onSlotSelect(slot.appointmentid)}
                          >
                            <Clock className="h-4 w-4 shrink-0 text-primary" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">{slot.starttime}</p>
                              {provider && (
                                <p className="truncate text-xs text-muted-foreground">
                                  {provider}
                                </p>
                              )}
                            </div>
                            <Badge variant="outline" className="shrink-0 text-xs">
                              {slot.duration} min
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              onClick={onConfirm}
              disabled={!selectedSlotId}
              className="gap-2"
            >
              {selectedSlotId ? (
                <>
                  Continue &mdash; {selectedSlot?.starttime}{" "}
                  {selectedDate?.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </>
              ) : (
                "Select a time slot"
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
