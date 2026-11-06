# Saathi customization guide

28 October2026. Upstream inspected at `60fd4c71d9d82e13739dce00827278154d13c947`, [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet). Fork: [anirbanhere/OpenDuet](https://github.com/anirbanhere/OpenDuet). MIT notices remain intact.

## What this fork changes

The official extension point is a tenant package, so Saathi lives in `openbot/examples/saathi/` rather than replacing platform internals. `brand.yaml` names Saathi; three built-in agents and in-app workstreams cover everyday tasks, kitchen and stock; skills clarify useful drafts and missing tools. No connector grant/private knowledge root is seeded. The main assistant prioritizes appointments and practical errands.

Hindi/Tamil/Malayalam/Kannada/English response instructions are present. This does not localize the upstream UI or demonstrate model fluency, STT, TTS, code-switching accuracy or critical-field recognition. Initial acceptance should measure English/Hindi/Tamil, then evaluate Malayalam/Kannada. Upstream first-day/onboarding/morning-brief screens remain work/Gmail-oriented; adapting them is a next UI slice, not completed by changing a prompt.

The startup model profile uses `provider: openai` for the **compatible API protocol**, `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, and `BOT_MODEL=openrouter/free`. `model.yaml` reads the same `BOT_MODEL`, so the tenant and sample framework bot share the choice. A permitted specific `:free` model can replace it. OpenRouter's [free router](https://openrouter.ai/openrouter/free) selects available free models with requested feature support; key permissions/capacity still matter. A free catalogue entry is not a successful inference test. No new live call or paid fallback was made/configured here.

`saathi:check` validates local profile/tenant configuration without contacting services or printing keys. It refuses missing keys, the public zero encryption placeholder, non-OpenRouter endpoint, non-free model and non-loopback profile. It is a startup helper, **not** a runtime spend/action policy: an administrator can change the upstream model picker later. Keep key-level model/spend restrictions. Independent role-specific model pins and task-switch reconciliation from the Python reference have not been ported.

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

## Local setup

Use an isolated checkout and a Linux/WSL environment with working Docker Linux engine, Bun1.4.3 and Node/npx. Native Windows can validate the tenant/build; the upstream Bash/symlink/container startup is not verified there. No public ingress or cloud resources are created by these steps.

```sh
git clone https://github.com/anirbanhere/OpenDuet.git
cd OpenDuet
git checkout codex/saathi-kickoff
bun install --cwd openbot --frozen-lockfile
cp saathi.env.example openbot/.env
```

Fill **only this fork's** `openbot/.env`; do not copy the legacy `.env`. Put the existing operator-managed OpenRouter key into `OPENAI_API_KEY` and choose a key-permitted free model in `BOT_MODEL`. CopilotKit Intelligence needs a separate project key for `INTELLIGENCE_API_KEY`; upstream's [quick start](../../README.md#quick-start) describes its CLI login/project/learning-container setup. Confirm that remote thread/memory storage is acceptable before configuring it; the fully self-hosted alternative is a separate pending design choice. Run approved setup from this fork with one canonical `.env` as its guide requires. Do not place a key in chat, a committed file or a command-line argument. Generate a fresh random32-byte base64 encryption key in the private `.env`; the public all-zero placeholder is rejected at startup. The preflight checks shape/nonzero bytes, not cryptographic randomness.

```sh
bun run saathi:test
bun run saathi:check
bun run saathi:start
```

`saathi:start` checks the profile before invoking upstream `scripts/start.sh`; startup may build/start Docker services, migrate **this fork's** PostgreSQL and mint local tokens. It is not a preview-only command. `COMPOSE_PROJECT_NAME=saathi-openduet` separates its volumes from OpenDuet/OpenBot defaults. The intended local app is localhost:3010, API localhost:3001; actual startup must verify them. Do not expose `OPENBOT_SINGLE_USER=true` publicly.

On native PowerShell, `Copy-Item saathi.env.example openbot/.env` prepares the template. No actual key file was created in this implementation session. Config generation/build without credentials:

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
