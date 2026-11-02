# Saathi customization guide

[Offline speech tariff arithmetic](stt-cost.md) adds an isolated pure estimate/ceiling foundation; it does not connect live speech, reserve money or authorize execution.

[Local fixture review console](fixture-review-ui.md) separates explicit new synthetic runs from owned read-only history/result recovery, with pinned retry identity, privacy invalidation and no automatic transcript submission. Actual speech and public media remain disabled.

[Owned fixture status reads](fixture-status-reads.md) add bounded metadata and privacy-checked result recovery without new execution or ledger charges, under the same default-off/public-refused local fixture capability.

[Local fixture speech runtime](local-fixture-speech-runtime.md) connects owned fixture admission/settlement to an explicitly opted-in local HTTP operation and safe stop/drain lifecycle. Synthetic tone lookup is labelled, public/default mode stays off, and real speech/providers remain gated.

[Local WAV upload](local-media-upload.md) adds a separate off-by-default/public-refused owned consent/byte boundary. The [conditional upload/consent console](local-media-upload-ui.md) uses it with explicit choices and duplicate-safe same-tab retry. No microphone, speech processing, playback or model call is enabled.

[Operator media maintenance](media-maintenance.md) adds an explicit absolute-database/count-only dry run and explicit apply for supported schema11 expiry clearing. It refuses active ownership and performs no migration/startup recovery. No existing user/public profile or live speech is enabled by this command.

[Local owned-media controls](local-media-controls.md) add an off-by-default, public-disabled bounded metadata list/revoke/delete boundary and conditional Saved audio privacy console. They reuse owner/CSRF/strict-body protections; no uploads, playback, transcript or live speech route is enabled.

[Keyless fixture STT execution](stt-coordinator.md) connects owned claims to synthetic adapters with bounded waits, cooperative cancellation and actual-acknowledgement slot retention. `bun run saathi:stt:fixture` demonstrates both providers/en-hi-ta on fresh temporary state. No existing profile, public audio route, real ASR or vendor registration.

[Private fixture claims and settlement](stt-claims.md) implement schema11 single audio/token handoff, authenticated settlement and retained-output privacy gates. No adapter, coordinator, public speech route or live provider is enabled by these primitives.

[Fixture STT admission](stt-admission.md) adds schema10 reservations and durable admission/audio-unit limits. No execution lease, provider call or public speech is enabled; one-shot claims and live-provider policy remain separate.

[Media consent revisions](media-consent.md) add internal schema9 history and exact current-consent checks. Processing leases/admission/spend and public speech remain pending; old consent history is not invented during migration.

[Internal owned media](owned-media.md) adds schema8 storage/consent/quotas/expiry and explicit BLOB clearing with tombstones. No public route or speech processing is enabled; existing public/private databases have not been migrated.

[Speech response policies](speech-replies.md) compose text/voice internally with explicit consent/failure/fixture states and no delivery. They do not enable public voice; owned media, durable consent/spend and actual evaluation remain pending.

[Vendor TTS transport foundation](vendor-tts.md) adds disabled/unregistered Sarvam/ElevenLabs factories with bounded WAV output and cancellation. Response policies, owned media, consent/spend integration and actual voice evaluation remain separate; mocked tones are not voice-quality proof.

[Vendor STT transport foundation](vendor-stt.md) implements internal disabled-by-default Sarvam/ElevenLabs factories and strict WAV inspection. They are not registered with public speech/media routes; tests use synthetic bytes and mocked HTTP only.

[Native read-step core](read-only-plan-steps.md) adds explicit local read/draft execution and persisted observations. It has no booking authority or public/UI deployment implied by its presence in the repository.

[Structured planning](structured-planning.md) adds saved draft proposals with pinned roles, strict tool/date contracts and shared inference budgets. It does not execute the proposed steps. Check HANDOFF for branch/CI status; a checked-in UI is not evidence of public deployment.

Independent model/speech configuration and the keyless synthetic contract evaluator are described in [provider roles](provider-roles.md). Model defaults route through their configured role while browser selection remains explicit. This does not enable public voice or finish generic planning; read current HANDOFF for source/CI/deployment evidence.

Current requirements: [root PRD](../../PRD.md), [requirement gap audit](prd-gap-audit.md), [controlled demo clinic](demo-appointments.md) and root HANDOFF. The text clinic workflow has its own durable task/review/approval/receipt path; live clinic, speech and reminders remain separate gaps. Earlier setup checkpoints below describe previous slices or the separate upstream platform.

Current inference continuation: [Meta keys and model selection](model-selection.md). This extends the local starter, not the full upstream worker/action platform or older Python deployment.

**Latest direction:** the human chose fully self-hosted threads/memory. Read [the runnable self-hosted guide](self-hosted.md) and HANDOFF first. Root `start`/`saathi:start` now select that local SQLite mode; no Intelligence project or Docker is needed. The guide below records the earlier full-upstream profile and remains applicable only to its explicitly named upstream/cloud commands.

28 October2026. Upstream inspected at `60fd4c71d9d82e13739dce00827278154d13c947`, [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet). Fork: [anirbanhere/OpenDuet](https://github.com/anirbanhere/OpenDuet). MIT notices remain intact.

## What this fork changes

The official extension point is a tenant package, so Saathi lives in `openbot/examples/saathi/` rather than replacing platform internals. `brand.yaml` names Saathi; three built-in agents and in-app workstreams cover everyday tasks, kitchen and stock; skills clarify useful drafts and missing tools. No connector grant/private knowledge root is seeded. The main assistant prioritizes appointments and practical errands.

Hindi/Tamil/Malayalam/Kannada/English response instructions are present. This does not localize the upstream UI or demonstrate model fluency, STT, TTS, code-switching accuracy or critical-field recognition. Initial acceptance should measure English/Hindi/Tamil, then evaluate Malayalam/Kannada. Upstream first-day/onboarding/morning-brief screens remain work/Gmail-oriented; adapting them is a next UI slice, not completed by changing a prompt.

The startup model profile uses `provider: openai` for the **compatible API protocol**, `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, and `BOT_MODEL=openrouter/free`. `model.yaml` reads the same `BOT_MODEL`, so the tenant and sample framework bot share the choice. A permitted specific `:free` model can replace it. OpenRouter's [free router](https://openrouter.ai/openrouter/free) selects available free models with requested feature support; key permissions/capacity still matter. A free catalogue entry is not a successful inference test. No new live call or paid fallback was made/configured here.

`upstream:tenant-check` validates the separate upstream profile/tenant configuration without contacting services or printing keys. It refuses missing keys, the public zero encryption placeholder, non-OpenRouter endpoint, non-free model and non-loopback profile. It is a startup helper, **not** a runtime spend/action policy: an administrator can change the upstream model picker later. Keep key-level model/spend restrictions. Independent role-specific model pins and task-switch reconciliation from the Python reference have not been ported.

## Architecture and remaining dependencies

```text
Web/mobile UI -> OpenBot Hono + CopilotKit runtime -> AG-UI agent
                   | gateway / approvals / audit      | granted tools
                   |                                  v
                   |                              isolated computer
                   v
              PostgreSQL + pgvector
Threads/memory -> CopilotKit Intelligence (required upstream service)
Chat inference -> OpenRouter compatible endpoint (initial free profile)
Speech         -> separate TRANSCRIPTION_* / VOICE_* (unconfigured)
```

This is an early upstream template, not an already-complete Saathi product. Its README advertises working approvals, credentials, routines, computer use and Google integrations. Those statements are upstream claims until the corresponding tests and end-to-end Saathi flows are verified. New prompts cannot prove that policy is correctly enforced. The initial tenant declares no MCP tool refs or knowledge roots; built-in platform tools still exist when the app runs and need runtime review before using real accounts.

CopilotKit Intelligence is required by the current boot configuration. A project/API key is separate from OpenRouter. Threads and memory go to that service when configured; disabling optional telemetry does not eliminate this data flow. Do not use private household data until this boundary is accepted. The initial fork has no connected Google, Composio, WhatsApp, clinic, train, grocery or bill-payment account. Existing Python integrations are not automatically available here.

## Separate upstream setup (optional; not the self-hosted starter)

Use an isolated checkout and a Linux/WSL environment with working Docker Linux engine, Bun1.4.3 and Node/npx. Native Windows can validate the tenant/build; the upstream Bash/symlink/container startup is not verified there. No public ingress or cloud resources are created by these steps.

```sh
git clone https://github.com/anirbanhere/OpenDuet.git
cd OpenDuet
git checkout codex/self-hosted-demo
bun install --cwd openbot --frozen-lockfile
cp saathi.env.example openbot/.env
```

This upstream mode uses `openbot/.env`, an OpenRouter key in `OPENAI_API_KEY` and a permitted `BOT_MODEL`. It also requires CopilotKit Intelligence and a fresh 32-byte vault encryption key. The human has chosen self-hosted storage instead, so do not configure this cloud mode as part of default Saathi setup. Its original requirements remain here for platform reference. Never copy the legacy `.env` wholesale or place a key in chat, a committed file or a command-line argument.

```sh
bun run saathi:test
bun run upstream:tenant-check
bun run saathi:cloud-start
```

`saathi:cloud-start` checks the upstream profile before invoking `scripts/start.sh`; startup may build/start Docker services, migrate **this fork's** PostgreSQL and mint local tokens. It is not a preview-only command. `COMPOSE_PROJECT_NAME=saathi-openduet` separates its volumes from OpenDuet/OpenBot defaults. The intended upstream app is localhost:3010, API localhost:3001; actual startup must verify them. Do not expose `OPENBOT_SINGLE_USER=true` publicly.

On native PowerShell, `Copy-Item saathi.env.example openbot/.env` prepares the optional upstream template. It is distinct from the starter's private `.env.self-hosted` profile. Config generation/build without credentials:

```powershell
$env:TENANT_PACKAGE_DIR='../examples/saathi'
bun run --cwd openbot generate:app-config
bun run --cwd openbot/app build
```

The tenant loader expects `TENANT_PACKAGE_DIR` relative to `openbot/server`, not the repo root. Never edit generated application config to rename the UI. A hosted OpenDuet-specific image/deployment recipe was not supplied by upstream at this checkpoint; plain OpenBot images do not automatically include Saathi. Do not deploy those as if customized.

## Development slices

| Order | Slice / acceptance | Suggested independent owner |
| --- | --- | --- |
| 1 | Tenant/profile/agent context; actual loader, free-profile failure tests, frontend build | Coordinator, current slice |
| 2 | Working Docker + Intelligence + one free model: synthetic chat, tool proposal, approve/deny, persistence/restart and duplicate-action rehearsal | Platform developer, unassigned |
| 3 | Saathi onboarding + explicit language preference; remove work/Gmail assumptions using real UI tests | UI developer, unassigned |
| 4 | Independent STT/TTS adapter evaluation with approved samples and en/hi/ta critical-field accuracy, latency, cost | Speech developer, unassigned |
| 5 | Add a controlled mock dental connector and validate exact preview/expiry/ownership/idempotency/reconciliation | Domain developer, unassigned |
| 6 | Permissioned real clinic/channel adapters, kitchen extraction and durable inventory; each requires its own acceptance | Re-plan after the first vertical slice |

These suggested lanes are not assignments. Confirm each human's scope and isolated branch before four parallel Claude sessions start. Shared gateway/contracts need a primary writer and agreed contract. Contributors write a ticket-specific handoff; coordinator updates aggregate status. No automatic team messaging.

## Hosting decision

Do not translate the existing Cloud Run Flask deployment directly. Upstream uses a continuously available worker, PostgreSQL/pgvector and isolated agent computers managed through Docker or a cluster. A single private Linux VM/Compose environment is a candidate for the first full rehearsal; managed API/database plus separately isolated computer workers is a later design. GCP account credit is not permission to provision paid resources; no VM, Cloud SQL, GKE, IAM or public endpoint was created. Cloud Run alone does not provide a host Docker daemon for this architecture.

Free inference does not make computer containers, storage, speech, hosted memory or cloud uptime free. Choose measured resource limits and review actual service terms/prices before hosting. Do not put an agent computer with unrestricted shell access beside provider/account secrets merely to simplify deployment.

## Verification and gaps

Read root HANDOFF.md for exact commands/results/CI. Focused tests validate a real tenant load and configuration rejection, and nearby upstream tests mock HTTP transports. They do not demonstrate live OpenRouter, Intelligence, ASR, approvals, bookings or a public site. The existing Python project's tests/deployment remain independent evidence, not test counts for this fork.

Read-only live information: [web lookup and date plan](live-web-plan.md), including the Meta opt-in, source evidence, costs and migration boundaries.
