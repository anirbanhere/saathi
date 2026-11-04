# Explicit help and owned task-status reads

## Scope and request contract

The development source adds `POST /api/control-read`, protected by the existing same-origin JSON, active cookie, CSRF, no-store and request-budget middleware. It accepts exactly one supported locale (en-IN/hi-IN/ta-IN) and an explicit help or status intent. It performs no natural-language classification and is not wired into chat, voice or WhatsApp. The explicit Help console is now described in localized-help-console.md; per-card status UI remains separate. Unsupported locales/intents, extra owner/model/capability fields and query selectors fail422; no silent language/action fallback occurs.

Examples (target ID is illustrative, not a real appointment):

```json
{ "intent": "help", "locale": "hi-IN" }
```

```json
{
  "intent": "status",
  "locale": "ta-IN",
  "target": { "kind": "demo_appointment", "id": "11111111-1111-4111-8111-111111111111" }
}
```

The other target kind is task_plan. A status requires the exact kind/UUID in the current owner's workspace. Missing/foreign/wrong-kind targets return the same404; invalid/expired internal owner context403, HTTP absent/expired cookie401. Model proposals do not authorize these calls. This is partial FR-006: generic cancel, stop reminders, forget task and disconnect provider execution remain absent, with the existing exact task UI/approval controls retaining authority.

## Read behavior and honest output

`ControlReads` is a separate minimal reader over the existing database. The existing `appointments.get/list` materialize approval expiry and append audit rows, so this read service deliberately does not call them. Neither it nor the HTTP endpoint migrates, recovers, mutates, replays or approves any task. Source schema15 and public schema7 remain unchanged; existing databases/public deployment were not accessed/upgraded.

The fixed format saathi-control-read-v1 returns locale, observed_at and action_executed=false. Help contains fixed localized guidance and configured capabilities. draft_planning_configured reflects the server's wiring, not provider/key/credit/availability verification. Other live speech/transaction/external-reminder capabilities stay false in this runtime. Help does not probe a model catalogue, provider account or network. Future real integrations must update this contract explicitly rather than leaving stale capability claims.

Status returns target plus evidence_scope=stored_task_metadata, a narrow status object and localized message/notice. The object contains only mode, stored_state, code, pending and updated_at. Demo mode is always mock; a recorded COMPLETED state yields mock_confirmed with an explicit simulation notice. Task plans remain draft_only, including DRAFT_READY. All persisted states are mapped exhaustively against the domain state types. Adding a domain state without reviewing its mapping fails TypeScript.

An APPROVAL_PENDING row whose deadline has passed projects code=approval_expired while stored_state remains the unchanged persisted value. This result does not materialize expiry, clear a nonce, increment a version or append an audit event. Normal task review/decision controls still enforce their own actual expiry. Cancelled plan pending=1 remains pending and gets an explanatory note; a read does not acknowledge execution, free capacity or erase charges. Only existing settlement/startup recovery can update that lifecycle.

No quote, receipt, nonce/hash, role configuration, raw goal/plan JSON, session/credential/executor fields or private ledger evidence is selected/projected. Metadata success does not validate the integrity of those excluded contents, verify an external receipt or certify real-world completion. Repeated reads are new snapshots, not idempotency/reservation records. Translations have schema/coverage tests; native fluency, Indic speech understanding and pilot acceptance are unmeasured.

## Snapshot, validation and failures

One synchronous deferred SQLite read snapshot checks current owner/session, reads bounded selected metadata and rechecks session expiry before return. State length/types, timestamps, expiry type and permitted pending/state combinations are validated. Pending approval without a usable deadline, unknown state, malformed metadata or storage failure produces fixed503 without echoing private values. State-derived codes are as of observed_at; concurrent later changes can appear on a later read. This is no background worker/status synchronization or provider-freshness guarantee.

No model/catalogue/provider call, inference attempt, usage reservation, SQL update, new account permission or external action occurs. Responses do not enable a gated channel or real transactions. Existing mutation APIs, approvals, cancellation and provider/spend guardrails are unchanged.

## Verification and continuation

Missing service/API tests were red first. Eight focused cases cover localized help/configuration honesty, effective approval expiry with unchanged data_version/audit/stored state and nonce secrecy, every demo/plan state label, foreign/wrong-kind/invalid/expired contexts, strict fields/locales/intents/query/auth/origin/CSRF, invalid metadata/storage, minimal projection despite unread raw JSON, final session expiry, cancelled pending state and restart/no replay or new usage. A fixture's same-day10:00 slot could already be past, so it now selects tomorrow without changing production timing rules.

Full suite/types/format/audit/packed and exact-source evidence belong in HANDOFF. No UI changed, so this slice uses HTTP/storage tests; existing browser download source remains untouched. The explicit localized Help console is now documented in localized-help-console.md. Next is exact-target per-card status using the same safe rendering/locale/focus/error boundaries. Do not intercept arbitrary chat or expand into mutating intents without concrete resource/approval design. Full FR-006, voice/channel access, provider disconnect and real action lifecycle remain unfinished.
