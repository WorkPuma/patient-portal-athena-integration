<!-- Space: dev -->
<!-- Parent: Iris: Self-Scheduling -->
<!-- Title: Initial Visit Registration -->
<!-- Label: published -->
<!-- Label: business -->
<!-- Label: registration -->
<!-- Label: patient-portal -->

# Initial visit registration

A self-serve flow on the patient portal at [my.example-patient-portal.com/register](https://my.example-patient-portal.com/register) that takes a prospective patient from "I want to become a Patient Portal Demo patient" to a booked first visit, without a login.

## Owners

| Role | Name |
|------|------|
| Process owner | Patient Access Lead |
| Technical owner | Patient Portal engineering |
| Compliance owner | Privacy and Security Officer |

## Outcome

A patient who completes this flow has:

- An Athena patient record with demographics, address, and communication consents.
- A Salesforce **Account** for the patient.
- A Salesforce **Lead** with **Online Registration Started = True**, `LeadSource = "Online Registration"`, eligibility result, primary insurance display, and UTM attribution. Linked to the Account via `Matched_Account__c`.
- A booked Athena initial visit (90 minutes).
- A Salesforce **Appointment** record with **Online Registration = True**, primary insurance, eligibility status, and last-checked timestamp. Linked back to the Lead via `Online_Registration_Appointment__c`.

The patient does not need a login to complete any of this.

## Patient journey

The diagram below shows where a patient comes from, the four steps of self-scheduling, and which staff team picks up the work after a registration lands.

```d2
direction: right

landing: Landing Page\n(example-patient-portal.com) {
  shape: rectangle
}

self_sched: Self-scheduling\n(my.example-patient-portal.com/register) {
  shape: rectangle
  step1: 1. Demographics
  step2: 2. Eligibility check
  step3: 3. Schedule visit
  step4: 4. Confirmation
  step1 -> step2
  step2 -> step3
  step3 -> step4
}

medicare_offramp: Medicare = No off-ramp\n(call 888-290-1209) {
  shape: rectangle
}

eligibility_decision: Eligibility result {
  shape: diamond
}

onboarding: Onboarding Specialist {
  shape: rectangle
  task1: Welcome call
  task2: Visit prep
  task3: Day-of reminders
}

iss: ISS (Insurance Service Specialist) {
  shape: rectangle
  task1: Verify coverage
  task2: Reconcile guided handoff
  task3: Flag unaccepted plans
}

unaccepted: Plan not accepted {
  shape: rectangle
  task: Decline + redirect to call line
}

landing -> self_sched: clicks Schedule first visit
self_sched.step1 -> medicare_offramp: Medicare = No
self_sched.step4 -> eligibility_decision

eligibility_decision -> onboarding: Active
eligibility_decision -> iss: Inactive / Indeterminate / Guided Handoff

iss -> onboarding: Verified, accepted plan
iss -> unaccepted: Recognized non-accepted plan
```

The triage rule is simple: an **Active** eligibility goes straight to Onboarding for visit prep. Anything else goes to **ISS** first. ISS verifies coverage by phone, and if the plan is one we don't accept, ISS contacts the patient and cancels the booked visit.

## Business flow

| Step | Patient action | What happens behind the scenes |
|------|---------------|--------------------------------|
| 1 | Fill demographics (name, DOB, sex, mobile, email, address, Medicare yes/no) | Creates Athena patient, Salesforce Account, Salesforce Lead with **Online Registration Started = True** |
| 2 | Pick insurance carrier or "I don't see my plan" | Runs eligibility check; updates Lead with **Eligibility Status**, **Primary Insurance**, **Eligibility Checked At** |
| 3 | Pick a clinic, clinician, and time | Books appointment in Athena; syncs to Salesforce as an Appointment record with **Online Registration = True** |
| 4 | Confirmation page | Patient is done |

## Business rules

| Rule | Condition | Action |
|------|-----------|--------|
| R1 — Medicare gate | Patient answers **No** to "Are you currently enrolled in a Medicare or Medicare Advantage plan?" | Show off-ramp screen with `888-290-1209` and `example-patient-portal.com/membership`. Athena patient is still created; no Salesforce Lead is created. |
| R2 — Required fields | First name, last name, date of birth, sex, mobile, email, **address**, and the Medicare answer must all be filled | Block the Continue button until complete. Address auto-completes via Google Places. |
| R3 — Duplicate detection | The patient matches an existing Athena record on enough fields to be a probable duplicate | Show "Looks like you're already with us" and stop. |
| R4 — Eligibility result | The eligibility check returns Active, Inactive, or Indeterminate; or the patient picks "I don't see my plan" | Stamp the Lead's **Eligibility Status** as `Active`, `Inactive`, `Indeterminate`, or `Guided Handoff` accordingly. Set Primary Insurance and Eligibility Checked At. |
| R5 — Government-funded skip | Eligibility resolves to a government-funded plan (Medicare Original, Medicaid, Tricare, VA/CHAMPVA) | Skip the membership step entirely; advance straight to scheduling. |
| R6 — 3-business-day review window | Patient reaches the calendar | The earliest bookable slot is **3 business days out**. Same-day, next-day, and day-after-next initial visits are not offered self-service. The window gives Onboarding and ISS time to review the new registration before the visit. |
| R7 — First available clinician | Patient picks **First available** instead of a named clinician | The portal surfaces the clinicians at that clinic with the **most open initial-visit slots in the next 90 days**, so the patient is more likely to land on a real available time. |
| R8 — Soft-fail philosophy | Athena, Hint, eligibility check, or Salesforce returns an error mid-flow | The patient is allowed to keep going. A `portal_registration_followups` audit row is written so back-office can reconcile manually. The patient is never blocked by a vendor outage. |
| R9 — Online Registration flag | Lead and Appointment created from this flow | Both records have **Online Registration** set to True so staff can spot self-scheduled patients on every list view. |

## Eligibility carriers

The portal verifies coverage against this list. Each entry maps to a payer identifier and a brand display.

Blue Cross Blue Shield, Medicare, UnitedHealthcare, UCare, Aetna, Medica, HealthPartners, Humana, Tricare, Tricare for Life, Minnesota Medicaid, VA or CHAMPVA, plus an **I don't see my plan** option that triggers a Guided Handoff to ISS.

The eligibility response is normalized into one of four states stamped on the Lead and the Appointment:

| Status | Meaning | Who handles it |
|--------|---------|----------------|
| **Active** | Coverage confirmed for the visit date | Onboarding Specialist |
| **Inactive** | Carrier returned an inactive policy | ISS |
| **Indeterminate** | Eligibility response could not be parsed cleanly | ISS |
| **Guided Handoff** | Patient picked "I don't see my plan" | ISS |

## Compliance and SLA

| Item | Commitment |
|------|------------|
| PHI in transit | TLS 1.2+ on every external call (Athena, Hint, eligibility vendor, Salesforce, Rainforest) |
| PCI scope | Card data is collected only inside the Rainforest hosted iframe; the portal never sees a card number |
| Audit trail | Every external call that fails writes an audit row with the step, patient ids, and error |
| Idempotency | The demographics and eligibility submissions are keyed and cached for 5 minutes to absorb duplicate submissions |
| Rate limits | 10 demographics submissions per hour per phone number; eligibility submissions keyed per registration session |

## Definitions

- **Onboarding Specialist** — staff member who prepares an active-eligibility patient for their first visit (welcome call, visit prep, day-of reminders).
- **ISS (Insurance Service Specialist)** — staff member who verifies coverage when eligibility is not Active, including the Guided Handoff bucket. ISS also flags plans we don't accept.
- **Online Registration flag** — boolean field on the Lead (`Online_Registration_Started__c`) and the Appointment (`Online_Registration__c`) marking records that came through self-scheduling.
- **Guided Handoff** — eligibility outcome when the patient picks **I don't see my plan**. The patient is allowed to schedule; ISS verifies coverage by phone before the visit.
- **Government-funded plan** — Medicare Original, Medicaid, Tricare, or VA/CHAMPVA. Skips the membership step.
- **3-business-day review window** — the calendar opens on the third available business day after registration, giving staff time to review.

## References

- [How-to: register a patient and trace the records into Salesforce](#) — same parent.
- LMS course: **Online Patient Registration: From Portal to Salesforce** (Onboarding Specialist track).
- Member Portal business doc — same parent.

---

**Owner:** Patient Access Lead · **Last reviewed:** 2026-05-06 · **Review cadence:** quarterly
