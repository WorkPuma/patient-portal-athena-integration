<!-- Space: SAL -->
<!-- Parent: Patient Portal (Next.js) -->
<!-- Title: Initial Visit Registration - Business Guide -->
<!-- Label: published -->
<!-- Label: business -->
<!-- Label: patient-portal -->
<!-- Label: registration -->
<!-- Label: insurance -->
<!-- Label: scheduling -->

# Initial Visit Registration

A prospective patient registers, has insurance verified, and books an Initial Visit at a Herself Health clinic in one sitting on `example-patient-portal.com`. No account is created. No phone call is required. The wizard replaces the inbound-Lead-plus-phone-call path the Onboarding Team has been running for new-patient acquisition.

## Ownership

| Role | Person or team |
|------|----------------|
| Process owner | Onboarding Team Lead |
| Technical owner | Patient Portal product team |
| Compliance owner | Privacy Officer (PHI), RCM Lead (eligibility), Clinical Operations (visit type rules) |

!!! info "Where each URL points"
    `example-patient-portal.com/register` is the live, patient-facing site (production). `my.example-patient-portal.com/register` is the **staging** alias used only by the product team for testing. Do not send patients to `my.example-patient-portal.com`.

!!! warning "PHI and audit"
    Demographics, insurance member IDs, and dates of birth move through this wizard. Do not paste full member IDs, full DOBs, or clinical notes into Salesforce free-text fields. Every step is already audit-logged in `portal_registration_followups`. Pull the audit row instead.

## Feature flag state (staging and production)

| Feature | Staging | Production | Effect |
|---------|---------|------------|--------|
| Initial Visit Registration | ON | ON | Wizard reachable at `/register` |
| Membership step | OFF | OFF | Step hidden from the wizard; Medicare and Medicaid patients always skip pricing regardless of flag |
| Dot chat bot | OFF | OFF | Conversational assistant is not visible to patients in either environment |
| Authenticated portal (sign-in, dashboard, messages) | OFF | OFF | See *Authenticated Patient Portal - Future Development* |
| Passive Clerk provisioning | ON | ON | A dormant account is silently created behind the scenes; the patient never sees it |

The Membership and Dot flags are intentionally off everywhere. The functionality exists in code so it can be turned on later, but no environment exposes it today.

## Audience

The Onboarding Team owns every booked visit. Other teams are FYI only.

| Role | What they do here |
|------|-------------------|
| Onboarding Team (primary) | Receive a Salesforce Lead for every booked Initial Visit. Confirm the appointment, confirm the patient qualifies, complete missing demographics or insurance details before the visit. Work the soft-fail follow-up queue. |
| Front Desk | Confirms the appointment day-of and reconciles any patient details flagged at check-in. |
| RCM | Watches eligibility soft-fail volume; backs up Onboarding on guided-handoff brands ("I don't see my plan"). |
| Care Coordination | Backup caller for "patient pending" rows when Onboarding is at capacity. |
| Marketing and Leadership | Awareness only. Drive traffic to `example-patient-portal.com/register`. Read the matrices to track throughput. Not on the operational queue. |

## Business flow

| Step | Actor | System | Action | Duration |
|------|-------|--------|--------|----------|
| 1 | Patient | Browser | Enters first name, last name, DOB, sex, mobile phone, email, address | ~2 min |
| 2 | Wizard | Athena, Hint, Clerk | Creates Athena patient, skeleton Hint record, dormant Clerk user | <3 sec |
| 3 | Patient | Browser | Picks insurance brand from 12 cards or "I don't see my plan" | <30 sec |
| 4 | Patient | Browser | Enters insurance member ID and policyholder relationship | <30 sec |
| 5 | Wizard | Stedi, Athena | Runs 270/271, resolves package, attaches insurance to Athena patient | <5 sec |
| 6 | Patient | Browser | Picks clinic, then provider (or "earliest available"), then time | <2 min |
| 7 | Wizard | Athena | Books Initial Visit. Visit type is selected by insurance class, not by the patient | <3 sec |
| 8 | Wizard | Salesforce | Creates a Lead in the Onboarding queue with full registration context | <2 sec |
| 9 | Onboarding Team | Salesforce, phone | Calls patient within 1 business day to confirm and qualify | Manual |

## Business rules

| Rule ID | Condition | Action | Exception |
|---------|-----------|--------|-----------|
| BR-REG-01 | Patient picks a commercial brand and 271 returns active commercial coverage | Book MBR Initial Visit, type 461, 60 minutes | None |
| BR-REG-02 | Patient picks Medicare, Medicaid, TRICARE, TRICARE for Life, or VA/CHAMPVA | Book Initial Visit, type 47, 90 minutes | None |
| BR-REG-03 | Patient picks Medicare and 271 carries an MA carrier | One automatic retry against the MA carrier; resolves to the MA-PPO package; visit type stays 47 | One retry only |
| BR-REG-04 | Eligibility returns inactive, member-not-found, or Stedi outage | No package attached; soft-fail audit row; visit type 47 booked anyway | None |
| BR-REG-05 | Patient picks "I don't see my plan" | Stedi not called; guided-handoff audit row written; visit type 47 booked | None |
| BR-REG-06 | Athena `enhancedBestMatch` finds an existing patient | Patient sees "Looks like you're already with us"; no duplicate created; no patient ID disclosed | None |
| BR-REG-07 | Athena slot is taken between view and book | Patient sees "That time was just taken - please pick another"; row marked resolved | None |
| BR-REG-08 | Athena patient create soft-fails (504, 422 demographic conflict) | Synthetic `pending-` patient ID issued; downstream rows tagged `PENDING_PATIENT`; no Athena calls made | Onboarding completes manually |
| BR-REG-09 | Membership flag is on (currently never) | Membership step appears between Insurance and Schedule | Government-funded patients always skip |
| BR-REG-10 | Visit booked successfully | Salesforce Lead created in Onboarding queue with full registration context | None |

## Insurance routing matrix

| Brand picked | Eligibility outcome | Athena package | Visit type booked |
|--------------|---------------------|----------------|-------------------|
| BCBS, UHC, UCare, Aetna, Medica, HealthPartners, Humana | Active commercial | Reverse-resolved from 271 to brand-specific commercial package | MBR Initial Visit, type 461, 60 min |
| Medicare | Active fee-for-service | Brand's Medicare FFS package | Initial Visit, type 47, 90 min |
| Medicare | Active and 271 carries MA carrier | Auto-retry resolves to MA-PPO package | Initial Visit, type 47, 90 min |
| MN Medicaid | Active | Medicaid-MN package | Initial Visit, type 47, 90 min |
| TRICARE, TRICARE for Life, VA/CHAMPVA | Active | Brand's gov package | Initial Visit, type 47, 90 min |
| Any | Inactive or member not found | No package attached, soft-fail audit row | Initial Visit, type 47, 90 min (safe default) |
| Any | Stedi outage | No package attached, soft-fail audit row | Initial Visit, type 47, 90 min (safe default) |
| "I don't see my plan" | Stedi not called | No package attached, guided-handoff audit row | Initial Visit, type 47, 90 min |

## What the Onboarding Team owns after a booking

A booked visit is the start of the Onboarding workflow, not the end. The same touchpoints used for inbound web Leads today apply.

| Action | When | Why it stays manual |
|--------|------|---------------------|
| Outbound call to the patient | Within 1 business day of the booking | Confirm appointment, confirm patient qualifies (in-network, in-area, age-eligible). |
| Verify any field the wizard couldn't | Before the visit | The wizard accepts blanks for non-Self policyholders and flags them as soft-fails; Onboarding closes the loop. |
| Disposition Lead in Salesforce (Qualified, Not a fit, Reschedule) | Before the visit | Same dispositions Onboarding uses for phone-call Leads today. |
| Cancel or rebook the Athena appointment if patient does not qualify | Before the visit | The wizard does not gate on qualification; that is an Onboarding judgment call. |

If the wizard's eligibility or attach step soft-failed, the Lead carries the same context (member ID, brand, payer response). Resolve in the same call. No separate ticket required.

## Compliance and SLA

| Requirement | Implementation | Audit cadence |
|-------------|----------------|---------------|
| HIPAA: every PHI access logged | `portal_registration_followups` writes one row per consequential decision | Continuous; reviewed weekly by RCM |
| Onboarding follow-up SLA | Lead in Salesforce within 2 seconds of booking; outbound call within 1 business day | Weekly Onboarding queue review |
| Eligibility soft-fail review | Soft-fail rows pulled daily; verbal verification before the visit | Daily by RCM |
| Pending patient (`pending-` prefix) follow-up | Audit row written immediately; manual call within 1 business hour | Hourly during business hours |
| Robots indexing | `noindex` set on the `(portal)` route group | Quarterly verification |

## Where the audit lives

Every wizard step writes one row to `portal_registration_followups`. Pull the row before reaching out to the patient.

| Step | `step` value | Success looks like | Soft-fail looks like |
|------|--------------|--------------------|----------------------|
| Patient create | `patient_create` | `outcome=success`, real Athena patient ID in `result` | `outcome=soft_failed`, `athena_patient_id` starts with `pending-` |
| Insurance attach | `insurance_attach` | `outcome=success`, Athena `insuranceid` in `result` | `outcome=soft_failed`, `error_code=ATHENA_*`, raw response in `payload.athenaResponseBody` |
| Eligibility check | `eligibility_check` | `outcome=success`, full 271 summary in `result` | `outcome=soft_failed`, `error_code=STEDI_*` or `GUIDED_HANDOFF` |
| Appointment book | `appointment_book` | `outcome=success`, Athena `appointmentid` in `result` | `outcome=soft_failed`, appointment id starts with `pending-` |
| Account provisioning | `passive_clerk_create` | `outcome=success`, Clerk user id in `result` | `outcome=soft_failed`; no patient impact, Clerk recovers on first sign-in |

## Handoffs and SLAs

| Trigger | Goes to | SLA |
|---------|---------|-----|
| Visit booked successfully | Salesforce Lead in Onboarding queue | Onboarding calls within 1 business day to confirm and qualify |
| Patient picks "I don't see my plan" | Audit row `error_code=GUIDED_HANDOFF`; flagged on the Onboarding Lead | Coverage verified before the visit, no later than 1 business day prior |
| Eligibility comes back inactive or AAA-rejected | Audit row `error_code=STEDI_*`; flagged on the Onboarding Lead | Onboarding works the queue daily; loops in RCM for verbal verification |
| Athena attach failed (4xx/5xx) | Audit row `error_code=ATHENA_*`; flagged on the Onboarding Lead | Onboarding completes attach during their qualifying call; Front Desk reconciles at check-in |
| Appointment slot disappeared mid-flow | Patient picks another slot; row marked resolved | None |
| Athena patient create soft-failed | `pending-` patient ID; downstream rows tagged `PENDING_PATIENT` | Onboarding calls within 1 business hour (Care Coordination as backup) |
| Duplicate detected on patient create | Patient sees "Looks like you're already with us" copy | None; patient self-resolves |

## What the patient never sees

- Eligibility AAA codes, 4xx Athena errors, 5xx Stedi errors. All become "We're looking into your insurance" plus a follow-up row.
- Membership pricing. The flag is off in both staging and production.
- Account creation prompts. The Auth UI flag is off in both environments. A dormant Clerk user is provisioned silently so a future SMS sign-in works.
- Dot the chat bot. The widget does not render in either environment.

## Definitions

| Term | Definition |
|------|------------|
| Initial Visit | The first appointment a new Herself Health patient attends. Either a 60-minute MBR visit (commercial insurance) or a 90-minute visit (government-funded coverage). |
| MBR | Membership-Based Relationship. The Herself Health membership-billable visit type. |
| AAA | An X12 270/271 segment that returns reject codes. Examples: `41` provider not enrolled, `72/73` member ID mismatch. |
| Soft-fail | A wizard step where the upstream system errored but the patient continued through the flow. Always produces a follow-up audit row. |
| Pending patient | A synthetic Athena patient ID prefixed `pending-`. Used when the real Athena create call failed. All downstream steps detect the prefix and skip Athena. |
| Guided handoff | Result for a patient who picks "I don't see my plan". Stedi is never called; an audit row is written for Onboarding to work. |

<details>
<summary>Troubleshooting</summary>

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Patient says "It told me it would call back, what now?" | Eligibility soft-fail row was written | Pull the row by phone or email; verify coverage manually; flip `status=resolved` after attach |
| Patient ID in Athena starts with `pending-` | Athena create soft-failed | Onboarding calls patient; Front Desk creates the patient manually and updates the row |
| Insurance row missing in Athena but registration shows success | Athena post-insert returned no `insuranceid` (preview-only quirk) or 5xx | Pull the audit row; confirm `insurance_id_synthesized=true`; recreate manually if synthesized |
| Patient never got a confirmation text | Reminder messaging is owned by the Athena/Hint reminder pipeline, not the wizard | Verify `consenttotext=true` on the patient record |
| Patient picked "I don't see my plan" then went silent | Guided-handoff queue not worked | Pull all `error_code=GUIDED_HANDOFF` rows daily; call patient before the visit |

</details>

## References

- [Initial Visit Registration - Technical Specification](ac:Initial Visit Registration - Technical Specification)
- [Authenticated Patient Portal - Future Development](ac:Authenticated Patient Portal - Future Development)
- *Stedi Eligibility Disambiguation* (`docs/stedi/disambiguation-analysis-2026-04-v2.md`)
- *Coverage Classification Sanity Check* (`docs/portal/coverage-classification-sanity-check.md`)
- *Insurance Package Catalog Reference* (the `portal_insurance_packages` table)

---

**Owner:** Patient Portal product team · **Last reviewed:** 2026-05-05
