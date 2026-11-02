# Saathi implementation plan

Implement the approved recommendation on OpenDuet revision
677e0fcd148d80b99dd788c6d6f9c1c9f40a72db. Preserve upstream approvals,
credential encryption, private Bot ownership, and computer isolation.

1. Establish the local fork, pinned runtime, and source lineage.
2. Add encrypted owner-scoped model configuration and request-scoped resolution.
   Prove two users cannot affect each other's provider, key, or selected model.
3. Add the official WhatsApp Agent Platform client and durable connection state.
   Prove cursor/replay behavior, creator pairing, rate limits, and safe retries.
4. Wire WhatsApp turns to private Saathi Bots through the existing headless
   runtime and approval gate. Reuse upstream tools and isolated computers.
5. Add companion settings for model keys, selection, WhatsApp pairing, and status.
6. Add product package, configuration, migrations, and running instructions.
7. Run focused tests, type checks, relevant regressions, database tests, and browser
   verification. Record external credentials needed for live verification.

## Threat boundaries

Session identity owns configuration. Message content cannot choose an application
owner or Bot. Provider and WhatsApp tokens are encrypted, write-only, redacted,
and sent only to fixed approved origins. A private Bot and browser profile belong
to one owner. Poll cursors advance only with durable ingestion. Unknown external
effects are reconciled rather than replayed automatically. Model settings never
mutate process-wide environment variables. Existing authorization is checked on
each run and approval decision.

## Verification

Use the upstream Bun lockfile and test framework. Install scripts remain disabled
unless individually inspected and needed. Test new behavior before implementation.
No live model, speech, or WhatsApp success is claimed without actual credentials.
The generic CopilotKit onboarding wizard is not part of this implementation.
