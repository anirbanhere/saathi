# Owned conversation and preference text export

## Available in this source branch

`POST /api/text-export` returns an owned JSON attachment for the explicit fixed scope `conversations_and_reviewed_preferences`. It uses the existing active session cookie, same-origin JSON, CSRF, request budget and no-store/security middleware. The exact body is `{ "scope": "conversations_and_reviewed_preferences" }`; extra fields, owner/thread selectors and query parameters are rejected. GET does not start a download. No model, catalogue, speech adapter, provider or remote tool is called. No SQL data or inference/speech usage is changed.

This is a limited text download, not full account export, a backup, account recovery, migration or erasure. The development console now exposes Download my text; see text-export-console.md for its explicit-click and browser boundaries. The endpoint becomes available when this source version is run; the public demo is unchanged. No existing private/public database was opened/upgraded. Schema remains15.

## Versioned output

The attachment filename is fixed `saathi-text-export.json`, Content-Type application/json, Content-Disposition attachment, Cache-Control no-store and nosniff. Its format is `saathi-text-export-v1`, with fixed scope, `complete_for_scope=true`, an exported_at request-start timestamp (milliseconds), arrays of owned threads and memories, and explicit excluded categories.

A thread projects only id, agent, created, updated and ordered messages; a message projects only id, role and exact content. Saved reviewed preferences project id, content and created. Owner identifiers, session/CSRF/cookie values, raw inference/claim/execution records and source evidence are not selected into the result. Task plans/appointments, financial/inference/speech journals, audio/retained transcripts, credentials/provider data and backups are explicitly outside the scope. Success says nothing about the completeness or integrity of those excluded areas.

Chat/preference text itself is included exactly, including Unicode, quotes, backslashes and control characters represented safely in JSON. It can contain sensitive text the user entered. This is not a redaction or secret-detection service, and downloaded copies cannot be recalled by later deletion/revocation.

## Bounded snapshot and failure behavior

The internal store method delegates to createOwnedTextExport with a trusted owner context. The HTTP caller authenticates that owner; this helper does not turn an arbitrary supplied owner ID into authority. It additionally requires a valid UUID and existing unexpired owner session. Current expiry is rechecked during bounded reads and before return. No new authentication flow or account linking is added.

One synchronous deferred SQLite read transaction gives consistent threads/messages/preferences. In WAL mode an independently committed change does not splice later rows into the current snapshot. It can appear on the next export. This follows [SQLite snapshot isolation](https://www.sqlite.org/isolation.html) and Bun's [synchronous transaction API](https://bun.sh/docs/runtime/sqlite). Runtime remains the repository-pinned Bun1.4.3; no upgrade or new driver method is required. The snapshot linearizes at its first database read, not after concurrent changes. A download does not guarantee ongoing authorization of already copied data.

Limits are30 threads,100 messages per thread,20 preferences and2000000 serialized UTF-8 bytes. Queries read one extra row to detect overflow. SQL selects bounded text/identity fields without first returning a corrupt oversized value. Valid rows are explicitly parsed/projected; malformed roles, IDs, dates, message sequence or content fail with a fixed unavailable503. IDs are never truncated into a different message lookup. Text is preserved whole or refused, never silently shortened. Exact JSON bytes are counted incrementally and finally; over-limit data returns413 without a partial success/attachment. One message batch is bounded by101 rows and its per-field byte ceiling; this is an in-memory bounded JSON export, not streaming or pagination.

Foreign/missing/expired context is denied; HTTP missing/expired authentication is401, invalid CSRF/origin403 and unsupported body/query422. SQLite/storage failures are fixed503 without raw database text. Repeated exports do not reserve attempts, invoke providers, mutate a ledger, generate approval, or replay a task. They are new read snapshots and can differ as data/time change.

## Verification and remaining work

Fresh synthetic tests cover empty scope, owned exact multilingual/control text, foreign-user exclusion, explicit projections and no sensitive column leakage; repeat reads/no commit/usage or model calls; deletion and reopen; bad/expired context and late expiry; corrupt rows and every row/UTF-8 byte budget; concurrent WAL updates and strict HTTP scope/auth/origin/CSRF/query/download headers. A test fixture initially assumed a SQLite function API absent from pinned Bun1.4.3; it now uses the existing trusted clock expiry checkpoint to commit an independent WAL writer during the read. No skipped concurrency assertion or runtime gate weakening was introduced.

The explicit console download control and synthetic browser evidence are now described in text-export-console.md. Preserve its limited scope/sensitive-copy wording, no automatic export/upload and accurate download-requested status. Full task/financial/media/account lifecycle and retained backups remain separate PRD work. Any private/public release still requires the existing reviewed backup/upgrade/release process; draft source tests do not deploy it.
