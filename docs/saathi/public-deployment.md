# Sharing the self-hosted demo

Live release, verified 29 October 2026: **[open the public demo](https://35.208.235.27.sslip.io/)**. Executable source `27de098`, reviewed in [PR15](https://github.com/anirbanhere/OpenDuet/pull/15). Independent reply/reasoning selection, saved structured proposals, explicit cached read-only checks and controlled mock appointments now run on schema v7. A stopped-VM snapshot preceded migration; synthetic thread/preference/mock receipt and the17-row inference ledger survived. The served bundle hash matches the checked build. Exact evidence is in HANDOFF. Public model allowance remains20 total/five per workspace per UTC day.

29 October 2026. Deployment target authorized by the human: `sathi-home-agent`, `us-central1`. The older `home-agents` Cloud Run deployment is separate and must remain unchanged. Exact live URL/source/resource status belongs in HANDOFF; a successful build alone is not deployment evidence.

## Runtime

```text
Browser -- HTTPS --> Caddy -- loopback HTTP --> Bun/Hono
                                               |--> SQLite on persistent disk
                                               |--> Meta or free OpenRouter
```

Bun runs the TypeScript/JavaScript backend; Hono handles requests. The backend validates each browser workspace and keeps provider credentials out of the browser. SQLite stores threads, messages, reviewed preferences, run receipts and daily inference-attempt usage. No GPU or locally hosted language model is needed. GCP is the operator's infrastructure; no CopilotKit Intelligence thread/memory service is introduced.

One `e2-micro` VM in `us-central1-a`, Debian 12, has a 10 GB standard boot disk and a separate retained 10 GB standard data disk. The database lives at `/var/lib/saathi/state.sqlite`. A mount dependency prevents the service starting against temporary storage if the data disk is unavailable. This is a small single-server prototype, not high availability. No automatic backup/export/account recovery is claimed.

The app binds to `127.0.0.1:8790`; Caddy owns public ports 80/443, redirects HTTP and obtains HTTPS certificates. A static IP plus `sslip.io` provides an initial shareable hostname; DNS and certificate issuance remain external dependencies, and a custom owned domain is preferable for a long-term service. The isolated VPC allows only public HTTP(S); SSH ingress is restricted to Google's IAP range. No SQL port or application port is exposed publicly.

## Public demo boundaries

- Browsers have separate anonymous HttpOnly/Secure/SameSite workspaces. Sessions expire after 24 hours; this is not verified identity, household sharing or cross-device recovery. Existing local workspaces are never uploaded. Use demonstration data.
- Explicit `SAATHI_PUBLIC_ORIGIN=https://...` enables the reverse-proxy boundary; Host and write Origin must match, CSRF remains required, and HTTPS responses carry HSTS. Local mode remains loopback-only.
- Default daily inference limits are **20 total / five per browser workspace**, resetting at midnight UTC. SQLite reserves an attempt atomically before inference. Failures/interruption consume the allowance; duplicates do not. Thread deletion and server restart do not reset it. This limits application attempts, not an exact currency ledger or all usage of the same key elsewhere.
- Meta Standard-mode text and OpenRouter free choices remain explicit. Paid OpenRouter and Contributor mode are disabled. No automatic inference retry or provider/model fallback occurs. Hackathon credits and billing amounts are not verified by deployment.
- Meta conversation selections have bounded native weather/public-site lookup. New task proposals use a separate eligible reasoning-model choice without native web tools; explicit read-only checks run only the controlled local clinic lookup/manual draft. Cached evidence is never a genuine booking/payment/message. Speech, WhatsApp and real account transactions remain off. Prompt text is not an authorization boundary.
- Deleting content removes live records; SQLite/WAL, infrastructure copies and provider logs have separate retention. The non-content usage ledger remains for quota integrity. The data disk is retained when the VM is deleted; deletion is not an automatic cleanup promise.

## Build and provision

Development packaging now requires complete fileSha256 input identities and the pure release_inputs.py guard; see [release input integrity](release-input-integrity.md). Older manifests must be rebuilt. `python deploy/public/release_inputs.py artifacts/public-build --check` validates a normal clean build without downloading a runtime, reading a profile or deploying; it never substitutes for the runtime-bearing release checks below. Current fixed assets include export/help/media/upload/fixture modules, and unknown extra files are refused.

Use Bun 1.4.3 and a clean committed fork checkout. From `openbot`, run the focused tests and server typecheck; the scoped GitHub workflow also checks the frozen test-type baseline on Linux. Local Windows has the earlier eight gallery path-text baseline mismatches; do not rewrite the baseline to suppress them.

```sh
bun scripts/build-demo.ts --audit --runtime
bun deploy/public/smoke-bundle.ts
python deploy/public/deploy.py
```

These three commands run from the fork root. `build-demo.ts` bundles only the starter with environment inlining **disabled**, copies tracked public tenant/assets and licences, and verifies the pinned Linux Bun package's published SHA-512 integrity. The manifest records the source, dirty state, bundle hash, shipped package versions and exact file list. Deployment refuses a dirty build. Packaging uses only that file list, rejects escaping/symlink inputs and scans configured secret values; old/untracked build-directory files are not swept into the archive.

The full upstream dependency audit reports advisories in non-bundled packages; this release does not ship that platform. Zod was patched to 4.6.6 and Hono to 4.13.14 after advisory review. The shipped four-package graph (Zod/Hono/YAML/Drizzle) has zero matching advisories in the observed audit. Build audit network/schema failures fail closed. Do not describe that as the whole repository being vulnerability-free.

Before uploading, inspect `gcloud meta list-files-for-upload` in `artifacts/public-build` using `deploy/public/upload.gcloudignore`. Actual upload is a tar archive of the manifest's explicit list, not the repository or a local database. The bundle, runtime binary, manifest, upstream licences, public tenant YAML/skills and web assets are the only package inputs. No `.env`, Git metadata, recordings, private workspaces, test databases or model credentials enter it.

`deploy.py` is an **explicit operator tool**, never a PR-CI deployment job. Initial provisioning prepares a private release bucket, scoped VM identity, provider secrets, isolated network and static address. Existing releases use `python deploy/public/deploy.py --update`: retain the VM/disk/address/identity, upload a manifest-only private archive, stop for a consistent regional snapshot, update startup metadata and restart. The update path does not rotate keys or change IAM/network. Provider values never enter the archive/CLI arguments/startup metadata. Only the two secrets grant secretAccessor; only the release bucket grants objectViewer.

The VM fetches secrets into root-only `/run/saathi/keys.env` (tmpfs) through its identity. Systemd passes them to the dedicated unprivileged app user. The app has a restricted filesystem, private temporary directory and 400 MB memory ceiling. A failed secret load prevents startup. Reboot restores the disk mount and reloads keys before the app. Release archive hash is checked before unpacking; startup metadata contains resource references only.

## Operate and recover

Inspect `gcloud compute instances describe saathi-demo --zone=us-central1-a --project=sathi-home-agent` and the HTTPS `/health` endpoint. Non-secret deployment state is in ignored `artifacts/public-deploy-state.json`; the startup completion marker is `SAATHI_BACKEND_READY`. Access logs are not enabled by the Caddy configuration; do not add raw prompt/key logging for troubleshooting.

The deploy helper creates missing resources; it does not silently replace an existing VM or reset its database. Updating an existing deployment requires intentionally updating its startup metadata/release and restarting the app. Keep the previous release directory and database backup until new-source persistence and ownership checks pass. Schema v3 adds non-content inference usage; v2 code cannot open it. Rollback must use compatible code/schema or a verified pre-migration backup; never falsify the version row.

Before replacing/deleting storage, stop the service and make a consistent database backup including any WAL state, or use SQLite backup tooling. Repointing `/opt/saathi/current` alone must not overwrite newer user data. Persistent disk is durable storage, not a backup. No automatic cleanup/retention job was added.

Stopping the VM ends model calls/compute execution, but a reserved/attached IPv4 and retained storage can still cost money. To remove hosting fully, preserve required data first, then explicitly remove the VM, reserved address, unused release objects/secrets and optional network resources. Do not automatically delete the retained data disk.

## Costs and verification

GCP's free tier may cover one eligible e2-micro VM and up to 30 GB standard persistent disk across the billing account; eligibility/other account usage is not verified here. Public IPv4 is listed at USD 0.005/hour (about USD 3.65/month), with network/storage/operations above free allowances additional. Model inference is separate; request ceilings are not provider credit verification. [GCP free tier](https://docs.cloud.google.com/free/docs/free-cloud-features), [network/IP pricing](https://cloud.google.com/vpc/network-pricing).

Required launch evidence: passing source/packed-service checks and scoped CI, valid public HTTPS, actual browser model selection, separate visitor ownership, one synthetic live reply and duplicate check, plus saved state after an actual service/VM restart. Record observed failures and exact source/resource IDs in HANDOFF. Do not infer those results from startup logs alone.

Lookup updates: follow [live web plan](live-web-plan.md). Run the explicit operator helper with --update only after clean-source CI and packaging. It checks the existing VM/retained disk, stops the app, makes a consistent regional disk snapshot, then changes startup metadata and starts the same VM. No secret rotation or IAM/network provisioning runs on this path. Schema v4 saves source metadata and preserves the v3 usage ledger; v3 binaries cannot open it. Keep compatible code for rollback; do not overwrite later user state with an old snapshot automatically. Native search is provider-billed separately and bounded to three read-only tool calls per inference attempt.

Schema v5 adds controlled mock appointment tasks/approval/receipts and the explicit appointments.js static module. It preserves v4 chat/source/preference/usage state. Before deploying it, stop and consistently snapshot the retained disk. After migration, v4 binaries cannot open the database. No runtime flag converts the demo clinic to a real provider. See demo-appointments.md and latest HANDOFF for exact tested/deployed source.

Schema v6 adds pinned draft-task roles/events; v7 adds immutable read observations. Both preserve earlier chat/source/preference/booking/usage state. Public upgrade verification observed usage17 before/after, schema5 to7, saved mock receipt/duplicate recovery and visitor isolation. The one explicitly approved capped Meta planning test ran locally with synthetic state and completed a plan/read; no extra paid public probe was made. Real public browser acceptance checked independent picker selection and390px layout without submitting another model request. Catalogue presence is not a guarantee of provider capacity or JSON/language quality.
