# Owned fixture status and result recovery

The development branch adds two read-only endpoints under the existing explicit local fixture capability. Configuration/public denial and parent owner/session/security middleware are unchanged. These reads do not reserve, claim, replay, charge, cancel or recover a worker; they expose already-saved owned state while storage is open. No UI, model/provider call, recording, real ASR, schema migration or existing-profile rollout is added.

| Endpoint | Response |
| --- | --- |
| GET /api/fixture-stt | At most20 recent owned metadata records, further tightened by an operator's owner-record cap; creation time descending, then ID descending |
| GET /api/fixture-stt/:id | One owned UUID admission's canonical fixture-labelled status/current privacy-checked outcome |

Both endpoints accept no query fields or owner/role/worker overrides. Unknown/foreign IDs return404; invalid IDs/query fields422; missing or expired exact sessions401 through the parent guard. Another active session for the owner cannot rescue an expired HTTP cookie. Default/public mode leaves both routes unregistered, including programmatic opt-in with public origin. Responses retain no-store/security headers and existing fixed503 storage errors.

Metadata includes only admission/request/media IDs, original consent revision, mode=fixture, saved state/pending and creation/update/expiry timestamps. SQL explicitly excludes retained outcome, role bundles and private audio/hash/token/settlement columns; it does not load all transcripts and strip them afterward. There is no client-selected limit, search, unbounded listing or implicit historical pagination. Historical completed/pending state is not proof of current consent or worker availability.

Result GET reuses LocalFixtureSpeechRuntime.view and the authoritative admission result/privacy checks. Current revoked/deleted/expired/stale consent suppresses retained text even if state remains completed. The output is bounded by the existing retained-outcome contract and includes the fixed synthetic-tone notice. No private executor credential or raw audio is returned. This is fixture evidence, never actual speech recognition or an execution/payment receipt.

Read access remains available after admission stop/failure while the store is safely open; admission poison still blocks new POST work. Ordinary reads do not write lifecycle transitions, clear expired data, refund units or perform startup recovery. Actual exclusive store reopen after process loss applies the existing interrupted/no-replay recovery once; subsequent reads report that state. The recent list is intentionally partial, and a result can become unavailable after consent/session expiry.

Tests use fresh synthetic stores/generated tones. They cover default/public/foreign/expired-session boundaries, UUID/query guards, deterministic bounded/tightened metadata, actual executed SQL nonprojection, unchanged rows/ledgers/provider counts, repeated read access after stop, consent/expiry/deletion suppression, preserved completed evidence across reopen, killed claimed-worker interruption/no replay/no refund through the HTTP read surface, and sanitized storage failure. Packed public smoke proves both routes absent. No browser UI changes occur in this increment; exact source/gates are in HANDOFF.

The next review console will consume these reads for explicit refresh/recovery. It must keep fixture labels, exact POST retry identity and current-consent authority separate. Live speech/provider access, actual cost/language evaluation, microphone/transcoding, identity and official channels remain gated.
