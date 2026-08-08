"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, MapPin } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface Suggestion {
  placeId: string;
  primary: string;
  secondary?: string;
}

export interface ResolvedAddress {
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onResolved: (resolved: ResolvedAddress) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

function makeSessionToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function AddressAutocomplete({
  value,
  onChange,
  onResolved,
  label = "Address",
  placeholder,
  disabled,
}: AddressAutocompleteProps) {
  const inputId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [resolving, setResolving] = useState(false);
  const sessionTokenRef = useRef<string>(makeSessionToken());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (input.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch("/api/portal/places/autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          sessionToken: sessionTokenRef.current,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        setSuggestions([]);
        return;
      }
      const data = (await res.json()) as { suggestions?: Suggestion[] };
      setSuggestions(data.suggestions ?? []);
      setActiveIdx(0);
      setOpen(true);
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        console.error("[AddressAutocomplete] fetch error", err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(value);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fetchSuggestions]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const selectSuggestion = useCallback(
    async (s: Suggestion) => {
      setOpen(false);
      setResolving(true);
      try {
        const url = new URL(
          "/api/portal/places/details",
          window.location.origin,
        );
        url.searchParams.set("placeId", s.placeId);
        url.searchParams.set("sessionToken", sessionTokenRef.current);
        const res = await fetch(url.toString());
        if (!res.ok) return;
        const data = (await res.json()) as ResolvedAddress;
        onResolved(data);
        sessionTokenRef.current = makeSessionToken();
      } catch (err) {
        console.error("[AddressAutocomplete] details error", err);
      } finally {
        setResolving(false);
      }
    },
    [onResolved],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = suggestions[activeIdx];
      if (s) void selectSuggestion(s);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div ref={containerRef} className="relative">
        <Input
          id={inputId}
          type="text"
          autoComplete="off"
          value={value}
          placeholder={placeholder ?? "Start typing your address…"}
          disabled={disabled || resolving}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {(loading || resolving) && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {open && suggestions.length > 0 && (
          <ul
            role="listbox"
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.placeId}
                role="option"
                aria-selected={i === activeIdx}
                className={cn(
                  "group flex cursor-pointer items-start gap-2 px-3 py-2 text-sm",
                  i === activeIdx && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void selectSuggestion(s);
                }}
              >
                <MapPin
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    i === activeIdx
                      ? "text-accent-foreground"
                      : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.primary}</p>
                  {s.secondary && (
                    <p
                      className={cn(
                        "truncate text-xs",
                        i === activeIdx
                          ? "text-accent-foreground/80"
                          : "text-muted-foreground",
                      )}
                    >
                      {s.secondary}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Powered by Google. We&apos;ll fill in the rest of your address for you.
      </p>
    </div>
  );
}
