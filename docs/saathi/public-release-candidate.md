# Local public-demo candidate — 5 November 2026

Local preparation is complete for the tested text/runtime improvements. Nothing was deployed and no existing workspace/database or paid/model request was used. The candidate is retained only in ignored artifacts. On final review, an offline scan used the already-configured credential values without displaying them; compressed and all uncompressed candidate inputs contain zero matches. No provider was contacted. The explicit operator path still revalidates/scans its repack before upload.

## Exact artifact

- Clean source: `3b81c85e194dbad0af69be4dbd7053fba7fbe28c` (PR55 completed documentation checkpoint, implementation dffc3ce).
- Local archive: `artifacts/saathi-candidate-keyless.tgz`,42,638,721 bytes.
- Archive SHA-256: `dd3825ab7826da67252f290c503d3705fb89e8c24fdbc0015e621fae50b90e0d`.
- Server SHA-256: `94bb01484d2ba143ea87eb7191e9cb3fa4481fad2c78749361c579af29c3b4c9`.
- Official pinned Bun1.4.3 Linux package integrity: `sha512-RArgnpjeXjaGzjp5h7Rs89cUYJutO8IyqR3itE8OBaBzEt8KNm2jp/YozxBHq4eFovwrQLryeSwTAcmiT+zcoA==`.
-25 declared regular inputs/24 SHA-256 pins; raw manifest self-excluded and bound by archive hash. All23 non-runtime input hashes equal the prior clean dffc3ce build. Registry metadata and cached runtime integrity were rechecked by the existing builder.

Clean audited build with --runtime and pure packing passed. Four shipped packages have zero observed advisory matches;29 wider upstream package advisories remain outside the shipped graph. The archive was read back, checked for exact member list/regular entries and byte equality with all declared inputs, then extracted only into a guarded fresh temporary directory. An ignored adapted copy of the existing packed smoke test used these extracted assets with Windows Bun1.4.3, no inherited provider/configuration environment and synthetic temporary SQLite state. Cached mock reads, failed-plan recovery, repeat-safe mock booking and ownership passed, with no outbound inference. Child process/state/extraction directory were cleaned. Linux package checksum was verified; Linux binary execution was not tested on Windows.

Evidence files: ignored public-candidate-evidence.json, public-candidate-build.log, prepare-candidate-local.py and candidate-extracted-smoke.log. Initial packaging was keyless; subsequent offline scanning cleared these exact archive bytes against the configured provider credentials. The explicit operator path must revalidate and scan again before any upload. Rebuilding/repacking can change archive identity; never reuse this digest for different bytes.

## Checks and current resources

Implementation dffc3ce scoped self-hosted41870191768, tenant41870191829 and security41870191777 pass: Linux stdlib15/15/no skips, self-hosted366/3442, server types/frozen239, actual input guard/audit/packed smoke. Wider41870191840 failed because macOS job126714887899 never acquired a hosted runner (zero steps/capacity annotations); aggregate verification failed on abandoned. This remains an unresolved required-platform result, not a code failure or an automatic waiver. No rerun was requested. Candidate source adds only documented checkpoints; its non-runtime artifact bytes match the tested implementation.

Read-only GCP inspection observed saathi-demo RUNNING in sathi-home-agent/us-central1-a. Data device saathi-data points to saathi-demo-data with autoDelete=false; identity is saathi-demo-vm@sathi-home-agent.iam.gserviceaccount.com. A first narrow formatter omitted nested fields; a second explicit disks/serviceAccounts projection supplied them. No stop/start/snapshot/upload/metadata/IAM/secret changes occurred. Public HTTPS health returned200 with self-hosted storage and actions/speech disabled. That does not inspect content or independently prove the database version.

The existing local non-secret deployment record identifies public source27de0986f21098a5173061000ba97a02ab01a3a5, schema7 per its prior verification, archive08b34bbbe378fac6d13fc4a222f125fc1a8618f070c4c39e0a80c439fd828b9a and prior snapshot saathi-demo-data-pre-web-20261029-145320. The prior snapshot name is a historical record, not a newly checked READY backup. Contributor PR18 remains OPEN on feat/saathi-whatsapp against main and is not included or modified. PRs through55 remain drafts; no main merge is proposed by this record.

## Concrete rollout and recovery

A future explicit update must retain that VM, data disk, address and scoped identity, keep existing startup budgets20 total/five per workspace/day, free OpenRouter/explicit Meta selection and public speech/media/actions disabled. Expected downtime is the VM stop, snapshot readiness, startup/package verification and migration period; duration is unmeasured. The existing --update helper uploads an explicitly scanned archive, stops the same VM, waits for a new consistent regional snapshot to be READY, changes startup metadata and starts the same VM. It does not rotate keys or broaden IAM. Do not use initial provisioning as an update workaround.

Before source15 opens the data disk, retain exact previous startup/release references and the new pre-upgrade snapshot. After startup verify HTTPS/public asset identities, separate anonymous visitor ownership, existing saved text/preferences/mock receipts and unchanged usage integrity using authorized synthetic/aggregate acceptance, plus persistence after a service restart. Do not inspect household rows as a status check or make an extra paid smoke call. The historical7-to15 synthetic regression supports the migration path; it does not certify unknown production customizations or actual disk restores.

If failure precedes migration and metadata was unchanged, the helper restarts the old release. After migration,27de098 cannot open15: switching the release symlink or falsifying the version row is invalid. Prefer compatible forward repair while preserving current data. Restoring a pre-upgrade snapshot requires an explicit operator decision about later-data loss and verified recovery, not automatic deletion/replacement of the retained disk. Existing disk snapshots are not proof of a completed restore exercise.

## Final rollout decision

Candidate review e0ca566 passed all configured CI: scoped42055529998, tenant42055530087 and wider42055530003 SUCCESS. Linux stdlib15/15, self-hosted366/3446, types/frozen239, audit/guard/packed checks pass. Tested merge3aa7585bad24807d6f187793eab134882e612998 has exact-source treea22a8f24abd7ec2b2bd050a53e976544a9825206. The prior platform acquisition failure is historical; no manual rerun/waiver was used. Candidate3b81c85 non-runtime bytes already match the tested implementation. Exact archive dd3825ab... remains unchanged after configured compressed/uncompressed secret scanning (zero matches).

The proposed final action is the existing same-VM --update workflow in sathi-home-agent/us-central1: preserve data disk/identity/address, revalidate/repack/scan exactly these pinned candidate inputs, upload privately, stop VM, require a new READY consistent disk snapshot, then start source15 and verify public ownership/persistence. No main merge, new services, key rotation, paid model probe, live speech/channel/action activation or old-data replacement is included. Compression metadata can change the final repack digest; record the actual digest before upload and never substitute changed inputs.

Existing human authorization covers public hosting in this project, while the user-supplied parent AGENTS explicitly says not to merge/deploy existing PRs implicitly. The candidate, tests, backup/downtime and recovery consequences are now concrete. Obtain the human's explicit final rollout decision for this current PR stack before the operational update. While it is pending, continue independent PRD work and leave the public service/data unchanged. The broader goal remains incomplete.
