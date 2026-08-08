<!-- Space: dev -->
<!-- Parent: Iris: Self-Scheduling -->
<!-- Title: How-to - Register a patient and trace the records into Salesforce -->
<!-- Label: published -->
<!-- Label: how-to -->
<!-- Label: registration -->
<!-- Label: salesforce -->
<!-- Label: patient-portal -->

# How-to: register a patient and trace the records into Salesforce

A walkthrough of the self-serve initial-visit-registration flow with the Salesforce side-effects called out at every step. Use this when verifying a registration end-to-end, debugging a missing Lead, or explaining the flow to a new joiner.

## Outcome

After following the four wizard steps, you will have:

- One Athena patient (and a Hint patient when an email is on file).
- One Salesforce **PersonAccount**.
- One Salesforce **Lead** linked to that PersonAccount.
- One Athena appointment.
- One Salesforce **Appointment\_\_c** linked to the Lead.

## Who this is for

Patient Access, RCM, Care Coordination, on-call Engineering. No Salesforce admin rights needed; read access to the `Lead`, `Account`, and `Appointment__c` objects is enough to verify each step.

## Prerequisites

- Access to the patient portal (preview, UAT, or production).
- A test phone number, email, and DOB you are willing to use.
- Salesforce access to the same org the portal writes into (UAT writes to `HH_UAT`, prod writes to `HH_Prod`).

!!! warning "Real records"
    Submitting through this flow creates a real Athena patient, real Hint patient, and real Salesforce records. Use clearly-synthetic names and a `+test` email if you are walking through in production.

## Key rules

1. The wizard is completable end-to-end **without a login**. A `regToken` JWT issued at step 1 is the only auth on the unauthenticated steps.
2. Salesforce writes happen at three different points (not one): Account at step 1, Lead at step 2, Appointment\_\_c plus Lead patch at step 4.
3. A patient who answers "No" to Medicare is off-ramped at step 1. The Athena patient is still created; no Salesforce Lead is created.
4. The booking endpoint only accepts initial-visit appointment type ids `47`, `223`, `461`, or legacy `142`. Anything else is rejected.
5. Every external call is wrapped in a soft-fail with a Supabase audit row. A red Salesforce error does not block the patient — it leaves a follow-up row.

## Quick steps

### Step 1 — Demographics (`/register`)

Open `/register`. Fill the form and click **Continue**.

![Demographics — empty](screenshots/01-demographics.png)

![Demographics — filled with synthetic data](screenshots/02-demographics-filled.png)

What the system does on submit:

| Action | Where |
|--------|-------|
| Create Athena patient (`createPatient`) | Athena |
| Create Hint patient (when `HINT_API_KEY` is set and an email was given) | Hint |
| Create Salesforce **PersonAccount** with record type `0128b000000YyZ6AAK` | Salesforce |
| Mint regToken (1-hour TTL) carrying Athena patient id, dobHash, optional Salesforce account id, UTM | Portal |
| When `PORTAL_PASSIVE_CLERK_ENABLED` is on, create a passive Clerk user | Clerk |

PersonAccount fields written: `RecordTypeId`, `FirstName`, `LastName`, `PersonEmail`, `PersonMobilePhone`, `PersonBirthdate`, `SourceSystemIdentifier` (Athena id), `HealthCloudGA__SourceSystem__c` = `"AthenaOne"`, `HealthCloudGA__SourceSystemId__c` = Athena id.

Verify in Salesforce:

```sql
SELECT Id, FirstName, LastName, PersonEmail, PersonBirthdate, HealthCloudGA__SourceSystemId__c
FROM Account
WHERE PersonEmail = 'docs-walkthrough@example-patient-portal.com'
ORDER BY CreatedDate DESC LIMIT 1
```

### Step 2 — Eligibility (`/register/eligibility`)

The patient picks their carrier. The page lists 13 brands plus an "I don't see my plan" handoff bucket.

![Eligibility — pick a carrier](screenshots/03-eligibility-brands.png)

For the walkthrough we use the handoff path so no real 270/271 transaction is sent.

![Eligibility — guided handoff confirmation](screenshots/04-eligibility-handoff.png)

What the system does on submit:

| Path | Action |
|------|--------|
| Stedi path (real carrier picked) | `runEligibilityCheck` against Stedi → `summarizeEligibility` produces coverage status and primary insurance type → `resolvePackageFromEligibility` maps to an Athena insurance package → attach to the Athena patient |
| Handoff path ("I don't see my plan") | Skip Stedi; record a stub insurance entry; mark `Eligibility_Status__c = "Guided Handoff"` |
| Both paths | `ensureLeadAtEligibility` creates the Salesforce **Lead** and stamps it on the regToken |

Lead fields written:

- `FirstName`, `LastName`, `Email`, `MobilePhone`
- `Company` = `"Individual"`
- `LeadSource` = `"Online Registration"` (default)
- `Matched_Account__c` = the PersonAccount id from step 1
- `Patient_ID__c` = Athena patient id
- `Online_Registration_Started__c` = `true`
- `Eligibility_Status__c` ∈ `Active` / `Inactive` / `Indeterminate` / `Guided Handoff`
- `Eligibility_Checked_At__c` = ISO timestamp
- `HealthCloudGA__PrimaryInsurance__c` = display string (truncated to 255)
- `utm_source__c`, `utm_medium__c`, `utm_campaign__c`, `utm_content__c`, `utm_term__c`, `utm_id__c`, `GCLID__c`

Verify in Salesforce:

```sql
SELECT Id, Name, Status, LeadSource, Eligibility_Status__c, Matched_Account__c,
       Patient_ID__c, Online_Registration_Started__c, Online_Registration_Appointment__c
FROM Lead
WHERE Patient_ID__c = '<athena id from step 1>'
ORDER BY CreatedDate DESC LIMIT 1
```

### Step 3 — Membership (`/register/membership`, optional)

When the membership feature flag is on **and** the eligibility result is not government-funded, the patient picks a plan and a payment method (via the Rainforest hosted iframe). Hint enrollment runs server-side. No Salesforce write here.

When the flag is off, or the carrier is government-funded (Medicare Original, Medicaid, Tricare, VA/CHAMPVA), the wizard skips this step.

### Step 4 — Schedule (`/register/schedule`)

Three sub-steps: clinic, then clinician, then time.

![Schedule — pick a clinic](screenshots/05-schedule-locations.png)

![Schedule — pick a clinician](screenshots/06-schedule-providers.png)

![Schedule — pick a time](screenshots/07-schedule-calendar.png)

What the system does on the **Book** click:

1. `bookAppointment` posts to Athena. The `appointmenttypeid` must be in the allow-list (`47`, `223`, `461`, or legacy `142`); otherwise the request is rejected with `REGISTRATION_TYPE_NOT_ALLOWED`.
2. `syncBookingToSalesforce` runs:
   - Creates an `Appointment__c` with `Athena_Appointment_Id__c`, `Start_Date_Time__c`, `Online_Provider_Name__c`, `Online_Location_Name__c`, `Status__c = "Scheduled"`, and `Patient__c` = PersonAccount id.
   - Looks up the Lead: `SELECT Id FROM Lead WHERE Patient_ID__c = '<athena id>' ORDER BY CreatedDate DESC LIMIT 1`. Falls back to `Matched_Account__c` if there is no `Patient_ID__c` match.
   - Patches the Lead's `Online_Registration_Appointment__c` with the new `Appointment__c` id.

Verify in Salesforce:

```sql
SELECT Id, Athena_Appointment_Id__c, Start_Date_Time__c, Status__c, Patient__c
FROM Appointment__c
WHERE Athena_Appointment_Id__c = '<athena appointment id>'
LIMIT 1
```

```sql
SELECT Id, Online_Registration_Appointment__c
FROM Lead
WHERE Patient_ID__c = '<athena id>'
LIMIT 1
```

### Step 5 — Confirmation and optional Clerk sign-up

The confirmation page shows the booked slot. The patient can choose to create a Clerk account; if they do, sign-up calls `POST /api/portal/register/claim/link` with the regToken, which links the Clerk userId to the Athena patient.

![Login screen reached after sign-up](screenshots/08-login.png)

## Decision matrix — which Salesforce records exist after each step

| After step | Account | Lead | Appointment\_\_c | Lead.Online\_Registration\_Appointment\_\_c |
|------------|---------|------|------------------|---------------------------------------------|
| 1 Demographics | Yes (PersonAccount) | No | No | n/a |
| 1 + Medicare = No off-ramp | Yes | No | No | n/a |
| 2 Eligibility (any path) | Yes | Yes | No | empty |
| 4 Schedule (booked) | Yes | Yes | Yes | populated |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No Lead in Salesforce after step 2 | PersonAccount creation soft-failed at step 1, so the eligibility step had no `salesforceAccountId` to link to | Check the Supabase `portal_registration_followups` table for a `step: "patient_create"` row. Manually create the PersonAccount, then patch the Lead's `Matched_Account__c`. |
| Appointment\_\_c missing after a successful booking | Salesforce write failed; Athena booking still succeeded | Check `portal_registration_followups`. Athena is the source of truth; back-fill `Appointment__c` from the Athena appointment id. |
| Lead has `Online_Registration_Appointment__c` empty even though Appointment\_\_c exists | Lead lookup at step 4 fell back to `Matched_Account__c` and found a different Lead, or none | Re-run the lookup: SOQL by `Patient_ID__c` first, then `Matched_Account__c`, pick the most recent. |
| `REGISTRATION_TYPE_NOT_ALLOWED` on book | The wizard sent an `appointmenttypeid` outside `47, 223, 461, 142` | Check `src/lib/scheduling/appointment-types.ts` — the variant resolver picked the wrong type. Fix the resolver, do not loosen the allow-list. |
| Duplicate detection blocking a real new patient | The fuzzy match score against Athena ≥ 23 | The patient should sign in instead. If they truly are new, change a distinguishing field (typo correction) or have staff merge after registration. |
| Eligibility returns "Indeterminate" | Stedi 271 missing or ambiguous | Lead is still created with `Eligibility_Status__c = "Indeterminate"`. Staff verifies coverage before the visit. |

## References

- Initial visit registration business doc — same parent.
- Member Portal business doc — same parent.
- Code:
  - `src/app/api/portal/register/patient/route.ts` — PersonAccount + regToken
  - `src/app/api/portal/register/eligibility/route.ts` — Lead create
  - `src/app/api/portal/register/appointments/book/route.ts` — Appointment\_\_c + Lead patch
  - `src/lib/salesforce/field-tolerant.ts` — resilient create/update used by all three writes
  - `src/lib/scheduling/appointment-types.ts` — initial-visit allow-list

---

**Owner:** Patient Portal engineering · **Last reviewed:** 2026-05-06 · **Review cadence:** quarterly
