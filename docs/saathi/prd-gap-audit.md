# PRD implementation audit — 29 October 2026

**Latest public release:** source27de098 now runs independent planner selection, saved typed proposals and cached read-only evidence on schema v7, after a consistent snapshot and preservation checks. One approved local Meta plan/read succeeded; approval consumed. Public speech/live actions remain off. See current HANDOFF and public-deployment.md for exact evidence.
**Shipped after this audit:** the controlled demo clinic text workflow is now live at https://35.208.235.27.sslip.io/. Choose **Try a demo appointment**. It adds owned tasks, exact expiring approval, slot contention protection, saved mock receipts, reject/cancel and reload recovery. No inference key is needed for this flow. It remains a simulation; real appointments, voice, reminders and general autonomous planning are not complete. Core PR9 and UI PR10 remain draft/unmerged. Deployed executable source: `9123f2f`; exact evidence is in HANDOFF.md.

Source: root `PRD.md`, copied unchanged from the human's replacement PRD in the Python repository. Later human decisions select this OpenDuet fork, fully self-hosted threads/memory and the existing GCP VM. Those decisions replace the PRD's suggested Python runtime stack, not its workflow requirements. No document authorizes live transactions or clears a provider/channel gate.

## Baseline before this continuation

Public executable source `52821a4`, PR8. Verified: web chat; owned SQLite conversations/reviewed preferences; anonymous 24-hour sessions; key-filtered Meta/OpenRouter picker; free/capped-paid policies; duplicate-safe inference and daily attempt ledger; bounded native Meta public lookup, page-open/source metadata and India dates. This is a useful chat/research demo, not the PRD's action-agent MVP.

The separate Python repository has tested mock task/approval/audio fixtures. They are reference implementation evidence only and do not run in the OpenDuet public site. Upstream OpenDuet features behind its different Intelligence/worker/bootstrap are likewise not automatically part of the self-hosted entry.

## Requirement ledger

| Requirement | Baseline in active runtime | This continuation / remaining gap |
| --- | --- | --- |
| FR-001 web/CLI/WhatsApp inbound | Web text only | Web demo booking; unified CLI/channel and official WhatsApp pending |
| FR-002 signed webhooks/dedup | Chat request IDs deduplicated; no webhooks | Signed official provider webhooks pending |
| FR-003 user/channel identity | Anonymous owner/session; no recovery/login | Verified identity/linking required before sensitive live actions |
| FR-004 context/preferences | Owned history and explicitly reviewed text preferences | Structured locale/timezone/address consent pending; demo task stores chosen locale |
| FR-005 WhatsApp window/templates | Absent | Eligibility, test number, templates and delivery access needed |
| FR-006 help/status/cancel/stop/forget/disconnect | Thread/memory deletion and saved inference state | Demo task status/cancel/reject; multilingual intents, reminder stop and provider disconnect pending |
| FR-007 secured voice media/transcoding | Internal WAV/consent/quota store, schema11 claims/settlement, private keyless coordinator/stop, local privacy/upload/initial-consent UI, operator expiry and bounded HTTP upload on development branches | Fresh synthetic evidence only; public mode refuses media controls/uploads. Native picker evidence limited by tool access; recording, playback, transcoding, runtime speech admission/shutdown integration, live-provider spend and actual ASR evaluation pending; existing data unmodified |
| FR-008 two STT adapters | Internal Sarvam/ElevenLabs wire adapters, owned media/consent, fixture durable budgets and keyless synthetic execution | Vendor factories disabled/unregistered; fixture execution is not live authority. Live-provider admission/spend, public routes/setup and consented evaluation remain pending |
| FR-009 two TTS adapters/policies | Internal Sarvam/ElevenLabs transports plus text_only/voice_only/text_and_voice composition | Disabled/unregistered factories and policies have mocked PCM/WAV/HTTP/cancellation checks; owned media, durable consent/admission/budgets and genuine provider/quality evaluation remain pending |
| FR-010 Indic/code-switching | Prompt language targets; no measured evaluation | en/hi/ta demo receipt text; actual speech/fluency evaluation and ml/kn work pending |
| FR-011 uncertainty/critical fields | Prompt guidance only | Demo date/slot/amount exact review; transcript confidence/critical-field evaluation pending |
| FR-012 independent reasoning/reply/STT/TTS | Immutable roles, independent chat/new-task model choice and durable draft-task pins | Synthetic speech swaps and redacted diagnostics tested; genuine speech/media and generic remote task execution remain incomplete |
| FR-013 typed task plans | Deterministic appointment plan; structured model proposals on planning branch | Up to three schema-checked read/draft steps, dependencies, risk, expected output, timeout and compensation; general execution/observe loop pending |
| FR-014 bounded agent loop/state | Native Meta tool cap; durable plans and native read-step branch | At most three local read/draft steps, saved observations and duplicate recovery; model-led observe/replan, remote tool steps and general resume loop pending |
| FR-015 clarification | Exact appointment date/slot; structured planning clarification state | Planning lookup dates must match a separate user-confirmed field; other material fields/natural-language extraction and live actions remain pending |
| FR-016 side-effect serialization/idempotency | Inference duplicate IDs and one pending run per owner | SQL mock reservation/decision idempotency; real provider reconciliation pending |
| FR-017 policy outside model | Provider/model/cost limits, read-only tool selection | Explicit server-owned mock approval, no model authorization; general tool/grant engine pending |
| FR-018 typed tool outcomes | Inference/mock states; native read-result outcomes on read-step branch | Local completed/unavailable/requires_user_action/retryable/permanently_failed observations; requires_auth and live-provider normalization pending |
| FR-019 native/MCP registry | No general tool registry | Fixed demo appointment capability only; remote MCP discovery/schema/auth/fees pending |
| FR-020 user capability grants | No authenticated account tools | Demo restricted to mock provider; per-user live grants/OAuth pending |
| FR-021 strict schemas/untrusted outputs | Zod HTTP/provider boundaries, safe DOM text, bounded responses | Strict appointment schemas; MCP returns and speech boundaries pending |
| FR-022 domain adapters | Public web lookup only | Controlled demo clinic; telephony/groceries/calendar/email/travel/payment adapters pending |
| FR-023 honest missing capability | Missing tools disclosed; no paid fallback | Explicit MOCK labels and disabled live actions maintained |
| FR-024 action risk/approval | No write-action engine | Mock booking requires UI approval; generic READ/DRAFT/BOOK/ORDER/PAY/etc policy pending |
| FR-025 canonical exact approval | Absent | Versioned quote/hash, ten-minute expiry, hashed nonce tied to owner/task/slot |
| FR-026 approve/reject/edit/replay | Absent | Demo approve/reject/slot change/re-review; official channel buttons pending |
| FR-027 prepare/review/commit/verify | Absent | Atomic SQL mock booking; non-atomic live IO/reconciliation remains a separate gate |
| FR-028 payment secrets/limits | No payments or secret collection | Still disabled; hosted checkout/authorized payments require separate integration |
| FR-029 owned receipts/terms | Chat source metadata only | Owned MOCK booking reference and no-charge terms; real provider receipts pending |
| FR-030 authorized telephony | Absent | Provider account/compliance/disclosure/approval/callback protocol needed |
| FR-031 recurring reminders/quiet hours | Absent | Durable scheduler, opt-in destination, retries/stop and notifications pending |
| FR-032 sourced travel/status | General Meta lookup only; no typed travel adapter | Authorized fare/train services and partner checkout/handoff pending |
| FR-033 family grants/revocation | Visitor isolation only | Household identity and resource-scoped sharing pending |
| FR-034 export/deletion | Owned thread/memory deletion; local opt-in media revocation/deletion clears BLOB/linked retained text atomically | No full export/account erasure; ledger/metadata, WAL/backups, provider and whole-account lifecycle remain pending |

This table distinguishes partial coverage from completion. The appointment implementation is not a measured voice MVP, generic autonomous planning engine, real clinic connection or complete Phase1 port.

## Implementation order

1. **Current slice:** durable controlled clinic demo, exact approval, mock receipt, cancellation/status/reload recovery, with the same public chat/research app retained. No provider key needed.
2. **Voice and role interchangeability:** independently typed STT/TTS/reasoning/reply roles; explicit upload consent and bounded media lifecycle; evaluate consented en/hi/ta samples. Add provider credentials only through private configuration when a concrete adapter is ready. Model access alone does not supply speech.
3. **General task tools and supported live clinic:** native/MCP manifests, owner grants, role-pinned plans, durable external operation/reconciliation ledger, real clinic/calendar access after explicit setup. Keep mocks in CI.
4. **Notifications:** SQL schedule/outbox, cancellable one-off/recurring reminders, quiet hours, delivery attempt/status semantics and an opted-in channel. A timestamp in a database is not a delivered reminder.
5. **Identity and lifecycle:** account recovery/linking, export/delete, retention/backup operations, operational observability before private household data or live account actions.
6. **Partner capabilities:** approved calendar/email, telephony, groceries/commerce, travel. WhatsApp/public rollout, IRCTC ticket issuance and payments retain the PRD's unresolved access/eligibility gates. No unofficial connector workaround.

Every slice needs an executable mock, boundary/ownership/error/restart tests and honest capability UI. No percentage-complete estimate is claimed: the remaining work includes partner access and evaluation, not merely coding effort.
