import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/portal/places/autocomplete
 *
 * Server-side proxy for Google Places API (New) `places:autocomplete`.
 * Keeps the server key out of the browser and lets us bind a sessionToken
 * for billing optimization (autocomplete + details counted as one session
 * when both calls share the same token).
 *
 * Body: { input: string, sessionToken: string }
 * Returns: { suggestions: { placeId: string, primary: string, secondary?: string }[] }
 */
export async function POST(req: NextRequest) {
  const key = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Address lookup unavailable" },
      { status: 503 },
    );
  }

  let body: { input?: unknown; sessionToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken : "";

  if (input.length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const res = await fetch(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
        },
        body: JSON.stringify({
          input,
          sessionToken: sessionToken || undefined,
          includedPrimaryTypes: ["street_address", "premise", "subpremise"],
          includedRegionCodes: ["us"],
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("[places/autocomplete] upstream error", res.status, text);
      return NextResponse.json(
        { error: "Address lookup failed" },
        { status: 502 },
      );
    }

    const data = (await res.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId?: string;
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }[];
    };

    const suggestions = (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.placeId)
      .map((p) => ({
        placeId: p.placeId!,
        primary: p.structuredFormat?.mainText?.text ?? "",
        secondary: p.structuredFormat?.secondaryText?.text,
      }));

    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("[places/autocomplete] error", err);
    return NextResponse.json(
      { error: "Address lookup failed" },
      { status: 500 },
    );
  }
}
