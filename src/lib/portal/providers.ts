/**
 * Curated provider directory for the portal scheduling experience.
 *
 * We combine two sources:
 *   1. **Athena `/providers`** — the source of truth for who is bookable
 *      (`providerid`, `displayname`, `specialty`, `npi`).
 *   2. **Storyblok `provider_profile` content** — patient-facing profile
 *      (`headshot`, `credentials`, `specializations`, `locations` slugs,
 *       `start_date` / `end_date`).
 *
 * The scheduler renders Storyblok-enriched provider cards filtered to the
 * clinic location the patient picked. Active filtering uses Storyblok's
 * `start_date`/`end_date` so provider hire/departure changes flow through
 * marketing's CMS workflow without a code deploy.
 *
 * Match strategy (Athena → Storyblok):
 *   - Normalize "firstname lastname" lowercase, strip "Dr. " prefixes,
 *     trim parenthetical alternates ("Naomi Machungo (Ongeri)" → "naomi
 *     machungo"), then exact-match against Storyblok story slug.
 *   - Athena name first (it knows the schedulable identity); Storyblok
 *     bio is decorative — providers without a Storyblok profile still
 *     appear, just without a headshot/bio.
 */

import { cacheGet, cacheSet } from "@/lib/upstash/cache";
import { getProviders, type AthenaProvider } from "@/lib/athena/client";

export interface PortalProvider {
  providerid: number;
  firstname: string;
  lastname: string;
  displayname: string;
  /** Marketing credentials (e.g. "DNP", "MD") parsed from displayname. */
  credentials: string | null;
  specialty: string | null;
  /** Storyblok-derived clinic slugs the provider practices at. */
  locations: string[];
  /** Storyblok headshot URL (Storyblok image URL, ready to use). */
  headshotUrl: string | null;
  headshotAlt: string | null;
  /** Optional patient-friendly title from Storyblok. */
  title: string | null;
  /** Storyblok specializations as a comma list. */
  specializations: string | null;
  /** True if the Storyblok bio exists and is currently active. */
  hasProfile: boolean;
}

interface StoryblokProvider {
  name: string;
  slug: string;
  full_slug: string;
  content: {
    name?: string;
    title?: string;
    credentials?: string;
    headshot?: { filename?: string; alt?: string } | null;
    specializations?: string;
    locations?: string[];
    start_date?: string;
    end_date?: string;
  };
}

// v2: previous Upstash entries built before Storyblok env vars were
// configured had `hasProfile=false` and empty `locations[]` for every
// provider, which made the scheduler render the entire Athena directory
// on every clinic. Bump on any directory-shape or build-time fix so we
// don't serve a poisoned snapshot through a 30-minute window.
const CACHE_KEY = "register-providers:v2";
const CACHE_TTL = 30 * 60; // 30m — providers change rarely; CMS edits cap at TTL

const SPECIALTIES_TO_INCLUDE = new Set([
  "family medicine",
  "internal medicine",
  "adult gerontology",
]);

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^dr\.?\s+/, "")
    .replace(/\s*\([^)]*\)/g, "") // strip parenthetical alternates
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCredentialsFromDisplay(displayname: string): string | null {
  const m = displayname.match(/,\s*(.+)$/);
  return m ? m[1].trim() : null;
}

function isActive(content: StoryblokProvider["content"]): boolean {
  const now = Date.now();
  if (content.start_date) {
    const start = Date.parse(content.start_date);
    if (Number.isFinite(start) && start > now) return false;
  }
  if (content.end_date) {
    const end = Date.parse(content.end_date);
    if (Number.isFinite(end) && end < now) return false;
  }
  return true;
}

async function fetchStoryblokProviders(): Promise<StoryblokProvider[]> {
  const token = process.env.NEXT_PUBLIC_STORYBLOK_TOKEN;
  if (!token) {
    console.warn(
      "[portal/providers] NEXT_PUBLIC_STORYBLOK_TOKEN is missing; provider profiles will be unavailable"
    );
    return [];
  }
  try {
    const res = await fetch(
      `https://api.storyblok.com/v2/cdn/stories?starts_with=providers/&content_type=provider_profile&per_page=100&version=published&token=${token}`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) {
      console.warn(
        `[portal/providers] Storyblok provider fetch failed: ${res.status} ${res.statusText}`
      );
      return [];
    }
    const data = await res.json();
    const stories = (data.stories as StoryblokProvider[]) ?? [];
    if (stories.length === 0) {
      console.warn(
        "[portal/providers] Storyblok returned 0 provider stories; check token/region"
      );
    }
    return stories;
  } catch (err) {
    console.warn("[portal/providers] Storyblok provider fetch threw", err);
    return [];
  }
}

function normalizeAthena(prov: AthenaProvider): {
  providerid: number;
  firstname: string;
  lastname: string;
  displayname: string;
  specialty: string | null;
  matchKey: string;
} | null {
  if (!prov.providerid || prov.billable === false) return null;
  const firstname = (prov.firstname ?? "").trim();
  const lastname = (prov.lastname ?? "").trim();
  if (!firstname || !lastname) return null;
  const displayname =
    prov.displayname?.trim() || `${firstname} ${lastname}`;
  const specialty = prov.specialty?.trim() || null;
  return {
    providerid: prov.providerid,
    firstname,
    lastname,
    displayname,
    specialty,
    matchKey: normalizeName(`${firstname} ${lastname}`),
  };
}

function buildStoryblokIndex(
  stories: StoryblokProvider[]
): Map<string, StoryblokProvider> {
  const index = new Map<string, StoryblokProvider>();
  for (const story of stories) {
    if (!isActive(story.content)) continue;
    const fromName = normalizeName(story.content.name ?? story.name ?? "");
    const fromSlug = normalizeName(story.slug.replace(/-/g, " "));
    if (fromName) index.set(fromName, story);
    if (fromSlug && !index.has(fromSlug)) index.set(fromSlug, story);
  }
  return index;
}

async function buildDirectory(): Promise<PortalProvider[]> {
  const [athena, storyblok] = await Promise.all([
    getProviders(),
    fetchStoryblokProviders(),
  ]);
  const sbIndex = buildStoryblokIndex(storyblok);

  const result: PortalProvider[] = [];
  for (const prov of athena) {
    const norm = normalizeAthena(prov);
    if (!norm) continue;
    const specialtyLower = norm.specialty?.toLowerCase() ?? "";
    if (!SPECIALTIES_TO_INCLUDE.has(specialtyLower)) continue;

    const sb = sbIndex.get(norm.matchKey);
    const headshotFilename = sb?.content.headshot?.filename || null;

    result.push({
      providerid: norm.providerid,
      firstname: norm.firstname,
      lastname: norm.lastname,
      displayname: norm.displayname,
      credentials: parseCredentialsFromDisplay(norm.displayname),
      specialty: norm.specialty,
      locations: sb?.content.locations ?? [],
      headshotUrl: headshotFilename ? `${headshotFilename}/m/400x500` : null,
      headshotAlt: sb?.content.headshot?.alt ?? null,
      title: sb?.content.title ?? null,
      specializations: sb?.content.specializations ?? null,
      hasProfile: !!sb,
    });
  }

  result.sort((a, b) => a.lastname.localeCompare(b.lastname));
  return result;
}

/**
 * Returns the curated, location-aware provider directory used by the
 * registration scheduler. Cached aggressively — Athena/Storyblok edits
 * flow through within {@link CACHE_TTL} seconds.
 */
export async function listProviderDirectory(): Promise<PortalProvider[]> {
  const cached = await cacheGet<PortalProvider[]>(CACHE_KEY, {
    prefix: "portal",
  });
  if (cached) return cached;

  const directory = await buildDirectory();
  await cacheSet(CACHE_KEY, directory, {
    prefix: "portal",
    ttl: CACHE_TTL,
  });
  return directory;
}

/** Filter the provider directory to those who practice at the given clinic
 * (Storyblok slug, e.g. "highland-park"). The Storyblok provider stories
 * are the source of truth for clinic affiliation — `locations: ["eagan"]`
 * etc. — so we only return providers whose Storyblok profile lists this
 * slug. Providers with no Storyblok profile are excluded.
 *
 * Earlier we tried to "soft-fail open" by returning the entire Athena
 * directory when Storyblok was unavailable, but that misrepresents which
 * providers are actually bookable at a clinic and was visibly wrong
 * (every clinic showed every provider). The scheduler now surfaces an
 * empty state if Storyblok is down; the upstream caller should retry or
 * route the patient to the human help fallback. */
export function filterProvidersByLocation(
  providers: PortalProvider[],
  locationSlug: string
): PortalProvider[] {
  return providers.filter(
    (p) => p.hasProfile && p.locations.includes(locationSlug)
  );
}
