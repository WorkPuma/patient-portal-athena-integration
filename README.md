# Patient portal with Athena EHR integration

A Next.js patient portal I built for a healthcare organization. Handles new patient registration, self-scheduling, insurance verification, membership management, and integrates with Athenahealth for the EHR side.

All integrations are stubbed. No real API keys, client IDs, endpoints, or patient data are included.

## What the portal does

**Registration (no account needed).** Demographics wizard with Google Places address autocomplete. Insurance verification via real-time 270/271 eligibility checks. Self-scheduling with a provider and location picker. Silent Clerk account creation with the Athena patient ID stored in metadata.

**Authenticated portal.** Dashboard with upcoming appointments. Appointment management (view, cancel, reschedule) via Athena. Secure messaging to the clinic. Membership management (view, renew, cancel). DOB verification and account linking.

**AI-assisted registration.** Retell voice and text bot tools that chain into the registration API. Cross-turn session state with encrypted tokens.

**Schedule links.** Shareable URLs with opaque tokens that bypass login. Token minted, resolved, and used to book directly. SMS delivery stubbed.

## Architecture

```
src/
  app/
    (portal)/portal/          Portal pages (Next.js App Router)
      register/               Multi-step registration wizard
      dashboard/              Authenticated dashboard
      appointments/           Appointment list, detail, scheduling
      messages/               Secure messaging
      membership/             Membership management
      login/                  Clerk sign-in
    api/portal/               API routes
      athena/                 Athena EHR proxy
      register/               Registration endpoints
      retell/                 Retell AI tools
      schedule-link/          Opaque token scheduling
      salesforce/             Salesforce Case creation
      identity/               Account linking + DOB verification
      places/                 Google Places autocomplete
  components/portal/          UI components
    registration/             Registration wizard, eligibility
    appointments/             Scheduling wizard, calendar
    dashboard/                Dashboard
    membership/               Overview, payment, cancel, renew
    messages/                 Message list + compose
  lib/                        Shared business logic
    athena/client.ts          Athena API client (OAuth2)
    salesforce/               Salesforce REST client
    stedi/                    Insurance eligibility (X12 270/271)
    retell/                   Retell SDK + HMAC verification
    scheduling/               Appointment types, tier policy
    auth/                     Registration tokens, Clerk session
    identity/                 Patient identity resolution
    upstash/                  Redis cache + QStash queues
```

## Getting started

Needs Node.js 22+, a Clerk app, and an Athenahealth developer account.

```bash
npm install
cp .env.example .env.local
# Fill in your integration values
npm run dev
```

Key environment variables: Clerk publishable key, Athena client ID and secret, Athena practice ID, Salesforce client ID, Retell API key, Stedi API key. See `.env.example` for the full list.

## Integration stubs

All external calls wire to `process.env.*` with no real defaults. The project compiles and runs, but API calls to Athena, Salesforce, Retell, Stedi, etc. fail until you provide credentials. The client files (`src/lib/athena/client.ts`, `src/lib/salesforce/client.ts`, etc.) show the OAuth2 flows and typed endpoints you need to implement.

## Built with

- [Next.js 15](https://nextjs.org) React framework (App Router, Server Components)
- [Athenahealth API](https://developer.athenahealth.com) EHR integration
- [Clerk](https://clerk.com) authentication
- [Salesforce](https://www.salesforce.com) CRM
- [Retell AI](https://retell.ai) voice and text agent for registration
- [Stedi](https://stedi.com) real-time insurance eligibility (X12 270/271)
- [Upstash](https://upstash.com) Redis and QStash
- Tailwind CSS v4 and Radix UI

Architecture docs are in [`docs/portal/`](docs/portal/).

## License

MIT
