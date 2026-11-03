# Explicit operator media expiry cleanup

This local operator command counts expired active clips and can explicitly clear their stored audio and linked retained STT results. It is separate from the website, anonymous sessions and model tools. It does not enable uploads, speech, background cleanup or account erasure. Current public schema7 and existing private profiles have not been upgraded or maintained by this work.

From the fork root, supply the absolute path of an existing supported schema11,12 or13 SQLite database. These versions share the same media/claim format; exact media guards are still validated. Schema12 policy catalogue and schema13 budget-hold metadata are unrelated and are never modified by this command. Unknown future versions are refused:

```powershell
# Default: report only; no media lifecycle writes.
bun run saathi:media:cleanup --database "C:\absolute\operator-reviewed\state.sqlite"
# Equivalent explicit dry run.
bun run saathi:media:cleanup --database "C:\absolute\operator-reviewed\state.sqlite" --dry-run
# Explicitly commit expiry clearing after reviewing the dry run.
bun run saathi:media:cleanup --database "C:\absolute\operator-reviewed\state.sqlite" --apply
```

These paths are placeholders. Do not try the command on the current user/public profile just to test development. For existing data, first stop the owning server/workers, preserve a consistent SQLite backup including outstanding WAL data, and separately review the supported-version upgrade. This command never performs that upgrade. Do not edit the version row to make a legacy database pass. No default `.saathi` path or configured private profile is selected. The script uses Bun's `--no-env-file` and imports no model/configuration/provider bootstrap; inherited environment variables do not select a database or authorize inference. A shell/package runner may echo the supplied command, so avoid sharing terminal logs containing private paths.

Successful stdout is one JSON aggregate, for example:

```json
{"mode":"dry_run","expiredClips":1,"expiredBytes":8044,"clearedClips":0}
```

`expiredBytes` counts currently stored BLOB bytes in expired active rows, not disk space reclaimed. Apply reports `mode=apply` and the number cleared in its transaction. A repeat sees zero eligible clips. Errors exit1 with fixed messages, without raw SQLite errors, identifiers, paths, content, credentials or transcripts. A failure after a commit during connection/guard release is reported ambiguously; inspect current state before retrying. There is no automatic retry or provider call.

The opener refuses nonexistent, nonregular or hard-linked targets, unsupported versions, missing required tables/columns/primary identities/foreign references, missing or changed invalidation triggers and extra triggers on the three media/STT tables. These are compatibility checks for the trusted local application database, not a complete forensic integrity check or support for arbitrary uploaded SQLite files. It opens the existing target with `create=false`; dry run uses a read-only connection and read transaction. Apply uses an immediate transaction, `OwnedMedia.purgeExpired`, consent history and the existing output-invalidation trigger. It does not construct `SelfHostedStore`, run migrations, switch journal mode, chmod the target or interrupt pending chat/plans/STT at startup. SQLite/ownership sidecar activity is possible even for dry run; the guarantee is no lifecycle/data writes, not no filesystem activity. See Bun's [SQLite open and transaction contracts](https://bun.sh/docs/runtime/sqlite).

Application and operator share the exclusive SQLite sidecar kernel guard. Canonical parent paths deduplicate directory aliases; file symlinks also acquire the target guard, and hard-linked database files fail closed. Normal-path sidecar locking remains compatible with older binaries. Older binaries opened through arbitrary file symlink aliases cannot be retroactively protected by the new helper: stop older runtimes before maintenance. Do not bypass a lock failure or use a PID-file workaround. The operator must control the database directory; concurrently replacing paths or a hostile local filesystem is outside this contract. Canonicalization follows Node's [realpath contract](https://nodejs.org/api/fs.html#fsrealpathsyncpath-options).

Expiry clears only active rows whose expiry is at or before the one captured clock value. It nulls audio, revokes both consent flags, advances the tombstone/revision and appends history; linked retained output is cleared atomically. Nonexpired clips and unrelated owner/session/chat/plan/booking and usage ledgers remain unchanged. A handed-out claim remains pending with its private token hash until acknowledgement or actual exclusive restart recovery; maintenance does not impersonate acknowledgement, refund units or replay work. No bytes already returned to a worker can be recalled. Logical clearing does not securely erase WAL pages, backups, provider copies or previously returned buffers.

Tests use temporary synthetic databases/generated tones only. They cover actual CLI parsing/output/exit codes, version and malformed-schema refusal, application/legacy-sidecar ownership, directory/file aliases, hard links, unchanged dry run, precise repeated apply, nonexpired/unrelated-state preservation, claimed pending-slot preservation and history-conflict rollback. File symlink coverage runs on Linux; Windows tests use directory junctions without requiring extra symlink privileges. Exact verification/CI source evidence belongs in root HANDOFF.
