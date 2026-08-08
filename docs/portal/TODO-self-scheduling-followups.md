# Self-scheduling — engineering follow-ups

Captured 2026-05-06. Tracks behavior changes promised in the LMS course "Online Patient Registration: From Portal to Salesforce" (lesson 1) that the codebase does not yet implement.

## 1. Create the Salesforce Lead at the demographics step (step 1), not the eligibility step (step 2)

**Today.** `POST /api/portal/register/patient` creates the Athena patient and Salesforce Account but **not** the Lead. The Lead is created at the eligibility step in `register/eligibility/route.ts` via `ensureLeadAtEligibility`.

**Required.** Lead must be created when the patient finishes the demographics form, with `Online_Registration_Started__c = true`, `LeadSource = "Online Registration"`, `Matched_Account__c` set, and `Patient_ID__c` set. Eligibility-related fields (`Eligibility_Status__c`, `Eligibility_Checked_At__c`, `HealthCloudGA__PrimaryInsurance__c`) are then **updated** on the existing Lead at the eligibility step rather than set at create time.

**Why.** Visibility for the ISS team. A patient who fills demographics and drops off before eligibility is exactly the kind of incomplete prospect the team needs to see in their Lead lists today.

**Files.**

- `src/app/api/portal/register/patient/route.ts` — add a `createLeadAtRegistration` helper analogous to `createOnlineRegistrationAccount` (around line 515). Stamp Lead id back into the regToken claims so the eligibility step can update rather than create.
- `src/lib/auth/registration-token.ts` — `salesforceLeadId` is already a claim; just populate it earlier.
- `src/app/api/portal/register/eligibility/route.ts` — convert `ensureLeadAtEligibility` (line 90) from "create or no-op" to "update only when `session.salesforceLeadId` is present; create as a fallback only".

## 2. "First available" surfaces clinicians with the most open initial slots in the next 90 days

**Today.** `InitialVisitScheduler.tsx` shows a "First available clinician — Show every open time at <clinic>" option. The available-slots endpoint (`src/app/api/portal/register/appointments/available/route.ts`) returns slots across all clinicians at the location for the requested visit-type.

**Required.** When the patient picks "First available", rank the clinic's clinicians by the **count of open initial-visit slots in the next 90 days** and present them in that order. The patient still sees a single "First available" option visually, but the slots returned are weighted toward the clinicians who can actually take them.

**Why.** Higher booking-conversion rate, fewer dead-ends in the calendar.

**Files.**

- `src/lib/portal/providers.ts` — add a 90-day capacity rank helper.
- `src/app/api/portal/register/appointments/available/route.ts` — when no `providerId` is sent, sort the slot stream by clinician capacity rank.
- `src/components/portal/registration/InitialVisitScheduler.tsx` — no UX change, just a copy tweak ("Recommended clinician based on availability").

## 3. Make address required on the demographics step

**Today.** `RegistrationWizard.tsx` marks `address1`, `city`, `state`, `zip` as optional. The wizard advances even when the patient leaves them blank.

**Required.** Address line 1, city, state, and zip must all be required to submit demographics. The Google Places autocomplete already populates them when a patient picks a suggestion; we just need to enforce non-empty values before `POST /api/portal/register/patient` fires.

**Why.** Athena and Hint both want a deliverable address on the patient record. Empty addresses create downstream cleanup work for ISS and billing.

**Files.**

- `src/components/portal/registration/RegistrationWizard.tsx` — add `required` on the address1, city, state, zip inputs (around lines 479–542); add a pre-submit guard with a clear error message ("Please complete your address.").
- `src/app/api/portal/register/patient/route.ts` — promote `address1`, `city`, `state`, `zip` from optional to required on `RegisterPatientPayload` (lines 43–80) and validate before `createPatient`.

## 4. Populate the new Appointment\_\_c fields at booking time

The Salesforce metadata for `Online_Registration__c`, `Primary_Insurance__c`, `Eligibility_Status__c`, `Eligibility_Checked_At__c` deployed to UAT today (commit `2512f4cf` on `feature/self-scheduling`). The portal's `syncBookingToSalesforce` does not yet write them.

**File.** `src/app/api/portal/register/appointments/book/route.ts` — extend the `Appointment__c` create payload (around line 87) to include the four new fields, sourced from `session` claims (already on the regToken).

Until this ships, the **Upcoming Initial Appointments - ISS** list view will read 0 items. The list view itself is live and ready.

---

**Owner:** Patient Portal engineering  ·  **Created:** 2026-05-06
