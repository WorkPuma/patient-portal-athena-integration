"use client";

import { MapPin, User, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Department {
  departmentid: string;
  name: string;
  city?: string;
}

interface SchedulingHeaderProps {
  departments: Department[];
  selectedDepartmentId: string;
  onDepartmentChange: (id: string) => void;
  providerName: string;
  editingLocation: boolean;
  onToggleLocationEdit: () => void;
}

export function SchedulingHeader({
  departments,
  selectedDepartmentId,
  onDepartmentChange,
  providerName,
  editingLocation,
  onToggleLocationEdit,
}: SchedulingHeaderProps) {
  const selectedDept = departments.find(
    (d) => d.departmentid === selectedDepartmentId
  );
  const locationLabel = selectedDept
    ? `${selectedDept.name}${selectedDept.city ? ` — ${selectedDept.city}` : ""}`
    : "Select location";

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 text-primary" />
          <span className="font-medium">Location:</span>
          {editingLocation ? (
            <Select
              value={selectedDepartmentId}
              onValueChange={(val) => {
                onDepartmentChange(val);
                onToggleLocationEdit();
              }}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((dept) => (
                  <SelectItem key={dept.departmentid} value={dept.departmentid}>
                    {dept.name}
                    {dept.city ? ` — ${dept.city}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-muted-foreground">{locationLabel}</span>
          )}
        </div>
        {!editingLocation && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onToggleLocationEdit}
          >
            Change <ChevronDown className="h-3 w-3" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-primary" />
        <span className="font-medium">Provider:</span>
        <span className="text-muted-foreground">
          {providerName || "Any available provider"}
        </span>
      </div>
    </div>
  );
}
