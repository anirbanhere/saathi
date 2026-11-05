# Release input integrity

Development source now fixes the stale deployment asset list and checks every packaged input, before any actual release. This changes operator packaging and source-only CI, not the public website, database schema or runtime flags.

`scripts/build-demo.ts` records `fileSha256` for every declared input except `manifest.json`. The latter cannot hash itself: its exact raw bytes are captured and bound by the final archive SHA-256. Existing source/dirty/Bun/server bundle/package/runtime evidence remains. Static UI changes therefore have individual identities even when the server bundle stays identical. Old manifests without the new hash map must be rebuilt; they are refused.

The pure `deploy/public/release_inputs.py` module has no import-time filesystem, credential, environment or network IO. Validation accepts exactly the current server/manifest/LICENSE, six public tenant YAML files, ten fixed browser assets and five notices, plus the Linux runtime when present. Future asset changes require an explicit policy/build/test change. Unknown/duplicate/noncanonical names, extra/missing hashes, malformed manifests, dirty/non-full-source/pinned-Bun mismatches, missing/non-regular/symlink/junction inputs and changed content are rejected. The manifest is limited to1MB, each input150MB and the captured total200MB. App bytes must also match bundleSha256; runtime bytes must match the recorded SHA-512 integrity.

The builder obtains that runtime integrity from the pinned npm distribution. Checking a recorded hash does not independently authenticate a registry, sign a manifest, approve source, prove dependency safety or defend against a malicious local operator replacing source and manifest together. These tools operate in a reviewed operator checkout; CI/source review/advisory audit remain necessary. Capturing checked bytes prevents later archive creation reopening changed input paths; no general hostile-filesystem race guarantee is claimed.

`pack_release()` always requires a runtime-bearing release. It checks/captures inputs, scans their uncompressed bytes for configured key values and writes only captured regular-file entries to a temporary archive. A final compressed-byte scan and archive digest precede atomic replacement. Failure preserves an existing archive and cleans the temporary file. Archive output cannot overwrite the build tree. Extra old files are never swept into the archive. This helper performs no cloud/key discovery, profile read, source migration or deployment.

The existing explicit operator `deploy.py` now calls pure validation before reading its private profile or calling cloud operations, then uses the shared packer with its configured keys. VM/disk/address/identity, snapshot/update semantics, IAM and secret bootstrap are unchanged. This continuation did not execute the actual deploy command or open a private profile. The integration test imports the operator module with CLI discovery mocked and proves an invalid build reaches neither profile reads nor cloud calls.

## Local and CI checks

From the fork root:

```powershell
python -m unittest discover -s deploy/public/tests -p "test_*.py" -v
python deploy/public/release_inputs.py artifacts/public-build --check
```

The second command is only for a clean current build. Explicit `--check` permits a normal no-runtime build to be validated; it cannot pack/deploy it. Without that flag, a verified runtime-bearing manifest is required. Normal scoped CI runs the stdlib tests, builds/audits, runs the offline normal-build check and retains the existing packed HTTP smoke test. No production keys, deployment job or runtime download was added.

Tests cover the actual current asset set, exact archive entries/content/digest, untouched excluded old files, changed browser/server/runtime content, malformed metadata/hash sets and JSON, duplicate/unknown/traversal/absolute/Windows names, missing/non-file/symlink build ancestry/parents/leaves, normal-build refusal as a release, safe errors/secret scanning/prior-archive preservation, captured bytes after a deliberate local mutation and operator ordering. Native Windows lacks symlink creation privilege for three cases; Linux scoped CI must supply that evidence. Native temp access was needed because the Windows sandbox denied its own temp directory; tests were not weakened.

Public release is still separate. The historical schema7-to15 synthetic preservation evidence remains in historical-upgrade-review.md; no actual public/private database was opened here. A real candidate still needs exact-source CI, a clean official-runtime artifact/archive, consistent retained-disk backup, same-resource update and observed public/restart acceptance under the applicable authorization. No paid/live inference probe, speech/channel/action activation or implicit main merge follows from packaging success.

Fresh-context adversarial review (doubt-driven-development) found a linked-ancestor gap: checking only the build directory/descendants allowed an artifacts ancestor to redirect the root. The implementation now rejects linked build ancestry before reads, with a valid-content ancestor-link regression. Follow-up review found no additional issue within the stated operator-owned checkout boundary. Cross-model skipped: non-interactive context.

Exact-source Linux scoped CI41870191768 subsequently passed all15 stdlib tests, including all three symlink cases with no skips, plus self-hosted366/3442, server types/frozen239, audit/actual normal-build guard/packed smoke. Tenant/security also pass; wider platform CI remains separate and pending in HANDOFF.
