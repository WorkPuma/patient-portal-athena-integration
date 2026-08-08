import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  getSalesforceToken,
  getSalesforceApiUrl,
} from "@/lib/auth/salesforce";

/**
 * GET /api/portal/salesforce/cases
 * List support cases for the authenticated patient.
 *
 * POST /api/portal/salesforce/cases
 * Create a new support case.
 */
export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  try {
    const sfAuth = await getSalesforceToken();
    if (!sfAuth) {
      return NextResponse.json(
        { error: "Salesforce unavailable" },
        { status: 503 }
      );
    }

    const apiUrl = getSalesforceApiUrl(sfAuth.instanceUrl);
    const query = `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Description, LastModifiedDate FROM Case WHERE ContactId = '${user.sfContactId}' ORDER BY CreatedDate DESC LIMIT 50`;

    const response = await fetch(
      `${apiUrl}/query/?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${sfAuth.accessToken}` } }
    );

    if (!response.ok) {
      throw new Error(`Salesforce query failed: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json({ cases: data.records || [] });
  } catch (error) {
    console.error("[Portal] Salesforce cases error:", error);
    return NextResponse.json(
      { error: "Failed to fetch cases" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const body = await request.json();
  const { subject, description, priority } = body as {
    subject: string;
    description: string;
    priority?: string;
  };

  if (!subject || !description) {
    return NextResponse.json(
      { error: "Subject and description are required" },
      { status: 400 }
    );
  }

  try {
    const sfAuth = await getSalesforceToken();
    if (!sfAuth) {
      return NextResponse.json(
        { error: "Salesforce unavailable" },
        { status: 503 }
      );
    }

    const apiUrl = getSalesforceApiUrl(sfAuth.instanceUrl);

    const response = await fetch(`${apiUrl}/sobjects/Case`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sfAuth.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ContactId: user.sfContactId,
        Subject: subject,
        Description: description,
        Priority: priority || "Medium",
        Origin: "Her",
        Status: "New",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Salesforce case creation failed: ${errorText}`);
    }

    const result = await response.json();
    return NextResponse.json({
      success: true,
      caseId: result.id,
    });
  } catch (error) {
    console.error("[Portal] Salesforce create case error:", error);
    return NextResponse.json(
      { error: "Failed to create support case" },
      { status: 500 }
    );
  }
}
