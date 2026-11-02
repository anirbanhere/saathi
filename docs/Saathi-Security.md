# Saathi dependency security status

Reviewed 30 October 2026. Scope: the web application and server dependencies in
`openbot/bun.lock`. Independent desktop, mobile, computer, and harness lockfiles
need their own audits before those components are released.

## Targeted patches

| Dependency | Previous locked version | Patched version | Advisory |
| --- | --- | --- | --- |
| Better Auth and installed adapters/plugins | 1.7.1 | 1.7.7 | [OAuth state / Magic Link confusion](https://github.com/advisories/GHSA-965c-763c-88jm) |
| DOMPurify, through Mermaid / Streamdown | 3.4.14 | 3.4.17 | [Shadow-root template sanitization bypass](https://github.com/advisories/GHSA-cg2g-xh64-v4q7) |
| proxy-addr, through Express | 2.0.7 | 2.0.8 | [IPv4-mapped IPv6 proxy trust bypass](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |

Better Auth packages move together, including the Drizzle adapter, Electron/Expo
integrations, SSO, and SCIM. DOMPurify and proxy-addr use exact root overrides so
transitive consumers resolve to the patched versions. The shared Better Auth core
is pinned to 1.7.7 as well, so optional peer resolution cannot select a different
release for its plugins. No new sign-in method or
proxy trust configuration was introduced.

The Better Auth advisory requires a combination of Magic Link and OAuth state
configuration. Magic Link was not found in this fork's configured server sign-in
plugins. DOMPurify's reported issue also needs specific non-default template and
DOM-returning options; those options were not found in application source. The
proxy-addr issue requires particular IPv6 trust subnet settings. These observations
do not certify every transitive call path. The fixes remove the vulnerable
versions rather than relying on those observations as a permanent mitigation.

When updating an existing deployment, follow the Better Auth advisory's
coordinated upgrade instructions for servers sharing verification storage.
Existing pending Magic Links and OAuth/SAML state may need to be restarted. This
fork has not been deployed with real accounts during development.

## Remaining findings

The baseline audit reported 122 advisories: three critical, 47 high, 54 moderate,
and 18 low. After the targeted patch, `bun audit --json` reports **112 advisories:
zero critical, 45 high, 54 moderate, and 13 low**.

Counts describe advisory matches in this lockfile, not distinct exploitable
application paths. A reduction to zero critical findings is not production
approval. High-severity findings remain in existing dependencies and require
reachability review and compatible updates before release. Keep the draft PR and
pilot gates until that review and live acceptance testing are complete.

Run audits against each committed lockfile immediately before release. Preserve
install scripts being disabled during dependency inspection, and validate any
needed native build scripts separately. Do not use a blanket force upgrade to
clear the remaining findings without checking runtime and connector contracts.
