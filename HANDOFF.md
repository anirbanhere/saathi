# Saathi on OpenDuet handoff

28 October2026, Asia/Kolkata. Human requested forking the repo linked in Atai Barkai's OpenDuet announcement and starting customization. Fork: https://github.com/anirbanhere/OpenDuet; origin is this fork, upstream is https://github.com/CopilotKit/OpenDuet. Base `60fd4c71d9d82e13739dce00827278154d13c947`, branch `codex/saathi-kickoff`. Preserve MIT notices. The Python Saathi/Home Agents repo, its open PRs and public GCP service were not migrated, merged or deployed.

## Implemented

- New official-extension tenant `openbot/examples/saathi/`: Saathi brand, main everyday-task assistant plus kitchen/stock specializations, three in-app workstreams, five instruction skills, no seeded connector tool refs/private knowledge roots.
- Response-language instructions for Hindi/Tamil/Malayalam/Kannada/English; first speech evaluation remains en/hi/ta. No claimed measured fluency, speech quality or UI translation.
- OpenRouter compatible endpoint/free-model startup example; one `BOT_MODEL` feeds the tenant and sample bot. `saathi:check` refuses missing provider/Intelligence configuration, wrong endpoint/protocol, non-free model and non-loopback profile; it prints names/readiness only. `saathi:start` runs this check before the upstream Bash startup.
- Root README, AGENTS/CLAUDE/SOUL/MEMORY, architecture/setup/roadmap guide and parallel developer handoff template. No actual four-person assignment exists.
- Focused no-secret CI workflow. No platform auth/gateway/approval code, lockfile, upstream model picker or production setting changed.

## Verification

- Pinned Bun1.4.3 and upstream frozen lockfile installed in an isolated local checkout; lifecycle scripts skipped for the dependency rehearsal. The Bun runtime/tooling is outside this repository.
- New test was red before the tenant/preflight implementation. Initial9 focused tests plus20 nearby upstream provider/URL tests passed. Review then reproduced acceptance of the public vault-key placeholder; a regression failed before adding the nonzero32-byte key check. Final counts are10 focused plus20 nearby tests. HTTP-provider tests use injected transports, not live accounts.
- Real Saathi application-config generation produced tenantId `saathi`, productName `Saathi`. Real Vite production build passed (17158 modules,24.54s); upstream warns about large bundles. No key/service is required for this build.
- `bun --env-file=saathi.env.example scripts/saathi-preflight.ts` validates the tenant and flags blank model/Intelligence keys plus the public encryption placeholder as NEEDS SETUP. This is an intentional incomplete-config result, not a live test. No actual `.env`/account key file was created.
- Docker Linux daemon is unavailable locally (`dockerDesktopLinuxEngine` pipe missing). Full startup, SQL migrations, real model/tool/approval execution, account connections, browser end-to-end flows and live speech have not been run.
- [Fork PR1](https://github.com/anirbanhere/OpenDuet/pull/1). Initial [Saathi CI40640536886](https://github.com/anirbanhere/OpenDuet/actions/runs/40640536886) passed tenant/provider tests and the actual frontend build at source `7533264`. Inherited [platform CI40640536945](https://github.com/anirbanhere/OpenDuet/actions/runs/40640536945) is separate; inspect current-head results before merge. Linux format/lint/types passed there; the local Windows type-baseline gate instead matched eight existing gallery diagnostics with absolute Windows paths against relative baseline text and failed. Baseline/source were not altered to hide it. Focused tests are not full-upstream-suite proof.

## Important limits

CopilotKit Intelligence is currently required upstream for threads/memory: a separate credential and remote data store. Optional telemetry is disabled in the example, but that does not make conversations local. Startup checks are not runtime spend enforcement; upstream UI can change models, so provider key guardrails remain necessary. No automatic paid fallback is configured.

Prompts cannot grant/enforce security. The upstream platform advertises approvals, credential isolation, computers and scheduling; verify each for the Saathi flow before using real accounts. Existing first-day/onboarding/brief UI remains work/Gmail-oriented. In-app workstreams do not implement WhatsApp groups, family roles or privacy isolation. Real booking, payment, grocery, media extraction, persistent inventory and WhatsApp are not connected by these YAML files. Do not claim their completion.

## Next concrete step

Review the feature PR. A human preference question is pending: use required CopilotKit Intelligence for the first demo or replace it with fully self-hosted thread/memory storage. Do not configure/send data to it until resolved. Docker Desktop is installed locally but stopped; no daemon/startup was launched. With the storage choice and Docker environment ready, map the already operator-managed OpenRouter key into this fork without exposing it, generate a fresh vault key, then run one synthetic free-model text/tool/approval/restart rehearsal. Do not connect household accounts, expose single-user mode publicly, create paid GCP resources or send third-party messages as part of this setup. Adapt onboarding and evaluate independent Indic speech in separate assigned slices; see docs/saathi/README.md.
