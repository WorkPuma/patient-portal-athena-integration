// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/upstash/cache", () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
}));

const getProvidersMock = vi.fn();
vi.mock("@/lib/athena/client", () => ({
  getProviders: () => getProvidersMock(),
}));

import {
  filterProvidersByLocation,
  listProviderDirectory,
  type PortalProvider,
} from "./providers";

const fixtureProvider = (
  overrides: Partial<PortalProvider> = {}
): PortalProvider => ({
  providerid: 1,
  firstname: "Naomi",
  lastname: "Machungo",
  displayname: "Naomi Machungo, MSN, APRN",
  credentials: "MSN, APRN",
  specialty: "Family Medicine",
  locations: ["crystal"],
  headshotUrl: "https://a.storyblok.com/x.png/m/400x500",
  headshotAlt: "Naomi Machungo",
  title: "Nurse Practitioner",
  specializations: "Women's Health, Primary Care",
  hasProfile: true,
  ...overrides,
});

describe("filterProvidersByLocation", () => {
  it("returns only providers whose Storyblok profile lists the clinic slug", () => {
    const directory = [
      fixtureProvider({ providerid: 1, locations: ["crystal"] }),
      fixtureProvider({ providerid: 2, locations: ["eagan"] }),
      fixtureProvider({
        providerid: 3,
        locations: ["lyndale", "eagan"],
      }),
    ];

    const eagan = filterProvidersByLocation(directory, "eagan");
    expect(eagan.map((p) => p.providerid).sort()).toEqual([2, 3]);

    const crystal = filterProvidersByLocation(directory, "crystal");
    expect(crystal.map((p) => p.providerid)).toEqual([1]);
  });

  it("excludes providers without a Storyblok profile so the scheduler doesn't list unbookable clinicians", () => {
    const directory = [
      fixtureProvider({
        providerid: 10,
        hasProfile: false,
        locations: [],
      }),
      fixtureProvider({ providerid: 11, locations: ["rosedale"] }),
    ];

    expect(
      filterProvidersByLocation(directory, "rosedale").map((p) => p.providerid)
    ).toEqual([11]);
  });

  it("returns an empty array when no provider lists the requested clinic — does NOT fall back to the entire directory", () => {
    const directory = [
      fixtureProvider({ providerid: 1, locations: ["crystal"] }),
      fixtureProvider({ providerid: 2, locations: ["eagan"] }),
    ];
    expect(filterProvidersByLocation(directory, "highland-park")).toEqual([]);
  });

  it("returns an empty array when Storyblok is unavailable (every provider hasProfile=false) — guards against the regression where every clinic showed the full Athena list", () => {
    const directory = [
      fixtureProvider({
        providerid: 1,
        hasProfile: false,
        locations: [],
      }),
      fixtureProvider({
        providerid: 2,
        hasProfile: false,
        locations: [],
      }),
    ];
    expect(filterProvidersByLocation(directory, "eagan")).toEqual([]);
  });
});

describe("listProviderDirectory (Athena↔Storyblok join)", () => {
  const ORIGINAL_ENV = process.env.NEXT_PUBLIC_STORYBLOK_TOKEN;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_STORYBLOK_TOKEN = "sb-test-token";
    getProvidersMock.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.NEXT_PUBLIC_STORYBLOK_TOKEN;
    } else {
      process.env.NEXT_PUBLIC_STORYBLOK_TOKEN = ORIGINAL_ENV;
    }
  });

  it("matches Athena providers to Storyblok stories by name and surfaces locations + headshot", async () => {
    getProvidersMock.mockResolvedValueOnce([
      {
        providerid: 100,
        firstname: "Naomi",
        lastname: "Machungo",
        displayname: "Naomi Machungo, MSN, APRN",
        specialty: "Family Medicine",
        billable: true,
      },
      {
        // Athena name has a parenthetical alternate; matching should strip it.
        providerid: 101,
        firstname: "Naomi",
        lastname: "Machungo (Ongeri)",
        displayname: "Naomi Machungo (Ongeri), DNP",
        specialty: "Internal Medicine",
        billable: true,
      },
      {
        providerid: 102,
        firstname: "Tracy",
        lastname: "Kritz",
        displayname: "Dr. Tracy Kritz, MD",
        specialty: "Family Medicine",
        billable: true,
      },
      {
        providerid: 103,
        firstname: "Front",
        lastname: "Desk",
        displayname: "Front Desk",
        specialty: "Reception",
        billable: true,
      },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          stories: [
            {
              name: "Naomi Machungo",
              slug: "naomi-machungo",
              full_slug: "providers/naomi-machungo",
              content: {
                name: "Naomi Machungo",
                title: "Nurse Practitioner",
                credentials: "MSN, APRN",
                headshot: {
                  filename: "https://a.storyblok.com/f/x/naomi.png",
                  alt: "Naomi Machungo",
                },
                specializations: "Women's Health, Primary Care",
                locations: ["crystal"],
              },
            },
            {
              name: "Dr. Tracy Kritz",
              slug: "tracy-kritz",
              full_slug: "providers/tracy-kritz",
              content: {
                name: "Dr. Tracy Kritz",
                title: "Physician",
                credentials: "MD",
                headshot: {
                  filename: "https://a.storyblok.com/f/x/tracy.png",
                  alt: "Tracy Kritz",
                },
                specializations: "Family Medicine, Women's Health",
                locations: ["highland-park"],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const directory = await listProviderDirectory();
    const byId = new Map(directory.map((p) => [p.providerid, p]));

    expect(byId.get(100)?.locations).toEqual(["crystal"]);
    expect(byId.get(100)?.hasProfile).toBe(true);
    expect(byId.get(100)?.headshotUrl).toBe(
      "https://a.storyblok.com/f/x/naomi.png/m/400x500"
    );
    expect(byId.get(100)?.title).toBe("Nurse Practitioner");

    // Parenthetical alternate name still matches the Storyblok story.
    expect(byId.get(101)?.hasProfile).toBe(true);
    expect(byId.get(101)?.locations).toEqual(["crystal"]);

    // "Dr. " prefix is stripped before matching.
    expect(byId.get(102)?.hasProfile).toBe(true);
    expect(byId.get(102)?.locations).toEqual(["highland-park"]);

    // Non-PCP specialty is filtered out entirely.
    expect(byId.has(103)).toBe(false);
  });

  it("excludes Storyblok stories whose end_date is in the past (provider departed)", async () => {
    getProvidersMock.mockResolvedValueOnce([
      {
        providerid: 200,
        firstname: "Departed",
        lastname: "Provider",
        displayname: "Departed Provider, NP",
        specialty: "Family Medicine",
        billable: true,
      },
    ]);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          stories: [
            {
              name: "Departed Provider",
              slug: "departed-provider",
              full_slug: "providers/departed-provider",
              content: {
                name: "Departed Provider",
                end_date: "2020-01-01T00:00:00.000Z",
                locations: ["eagan"],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const directory = await listProviderDirectory();
    const dep = directory.find((p) => p.providerid === 200);
    expect(dep?.hasProfile).toBe(false);
    expect(dep?.locations).toEqual([]);
  });

  it("returns providers without profile metadata when Storyblok fails (so the API still succeeds, even though the scheduler will show an empty clinic)", async () => {
    getProvidersMock.mockResolvedValueOnce([
      {
        providerid: 300,
        firstname: "Some",
        lastname: "Provider",
        displayname: "Some Provider, NP",
        specialty: "Family Medicine",
        billable: true,
      },
    ]);
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    const directory = await listProviderDirectory();
    expect(directory).toHaveLength(1);
    expect(directory[0]?.hasProfile).toBe(false);
    expect(directory[0]?.locations).toEqual([]);
    // And the per-clinic filter must be empty in this degraded mode.
    expect(filterProvidersByLocation(directory, "eagan")).toEqual([]);
  });
});
