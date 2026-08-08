"use client";

import { Building2, Video } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { VisitModality } from "@/lib/scheduling/appointment-types";

interface ModalityStepProps {
  onSelect: (modality: VisitModality) => void;
}

const OPTIONS: { value: VisitModality; label: string; description: string; icon: typeof Building2 }[] = [
  {
    value: "in_person",
    label: "In-Person",
    description: "Visit us at one of our clinic locations",
    icon: Building2,
  },
  {
    value: "telehealth",
    label: "Telehealth",
    description: "Video visit from the comfort of home",
    icon: Video,
  },
];

export function ModalityStep({ onSelect }: ModalityStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium">How would you like to be seen?</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose your preferred visit type to get started.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          return (
            <Card
              key={opt.value}
              className="cursor-pointer transition-all hover:border-primary hover:shadow-md"
              onClick={() => onSelect(opt.value)}
            >
              <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <Icon className="h-7 w-7 text-primary" />
                </div>
                <div>
                  <p className="font-medium">{opt.label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {opt.description}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
