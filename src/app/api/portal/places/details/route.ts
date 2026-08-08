import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/portal/places/details?placeId=...&sessionToken=...
 *
 * Server-side proxy for Google Places API (New) `places.get`. Extracts the
 * structured address components we need for the registration wizard:
 *
 *   { address1, address2, city, state, zip }
 *
 * `sessionToken` should match the one used for the autocomplete call so
 * Google bills both as a single session.
 */
type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

function findComponent(
  components: AddressComponent[],
  type: string,
): AddressComponent | undefined {
  return components.find((c) => c.types?.includes(type));
}

export async function GET(req: NextRequest) {
  const key = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Address lookup unavailable" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const placeId = searchParams.get("placeId")?.trim();
  const sessionToken = searchParams.get("sessionToken")?.trim();

  if (!placeId) {
    return NextResponse.json(
      { error: "placeId required" },
      { status: 400 },
    );
  }

  try {
    const url = new URL(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    );
    if (sessionToken) {
      url.searchParams.set("sessionToken", sessionToken);
    }

    const res = await fetch(url.toString(), {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "id,formattedAddress,addressComponents,location",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[places/details] upstream error", res.status, text);
      return NextResponse.json(
        { error: "Address lookup failed" },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      addressComponents?: AddressComponent[];
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };

    const components = data.addressComponents ?? [];
    const streetNumber = findComponent(components, "street_number")?.longText ?? "";
    const route = findComponent(components, "route")?.longText ?? "";
    const subpremise = findComponent(components, "subpremise")?.longText ?? "";
    const city =
      findComponent(components, "locality")?.longText ??
      findComponent(components, "sublocality")?.longText ??
      findComponent(components, "postal_town")?.longText ??
      "";
    const state =
      findComponent(components, "administrative_area_level_1")?.shortText ?? "";
    const zip = findComponent(components, "postal_code")?.longText ?? "";

    const address1 = [streetNumber, route].filter(Boolean).join(" ").trim();
    const address2 = subpremise;

    return NextResponse.json({
      address1,
      address2,
      city,
      state,
      zip,
      formattedAddress: data.formattedAddress ?? "",
      location: data.location,
    });
  } catch (err) {
    console.error("[places/details] error", err);
    return NextResponse.json(
      { error: "Address lookup failed" },
      { status: 500 },
    );
  }
}
