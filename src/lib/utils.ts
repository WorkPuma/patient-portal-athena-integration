import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines class names using clsx and merges Tailwind classes intelligently
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Check if we're on the server
 */
export const isServer = typeof window === "undefined";

/**
 * Check if we're in Builder.io preview mode
 */
export function isBuilderPreview(): boolean {
  if (isServer) return false;
  return window.location.search.includes("builder.preview");
}

/**
 * Build a canonical URL from base and path
 * Handles trailing slashes, double slashes, and empty paths consistently
 */
export function buildCanonicalUrl(baseUrl: string, path: string = ""): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!cleanPath) {
    return cleanBase;
  }
  return `${cleanBase}/${cleanPath}`;
}

/**
 * Get the site base URL from environment
 */
export function getSiteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "https://example-patient-portal.com";
}
