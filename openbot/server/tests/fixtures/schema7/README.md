# Synthetic deployed-schema fixture

`snapshot.sql` was generated using pinned historical store source27de098; provenance.json records extracted source digests, exact UTF-8/LF SQL digest and synthetic assertion references. See [the review](../../../../../docs/saathi/historical-upgrade-review.md) and `scripts/generate-schema7-fixture.py` at the fork root for regeneration and limitations.

No real household/account data, provider credentials or raw session tokens are included. Hashed synthetic sessions, synthetic CSRF and a mock-approval nonce are test data and grant no live access. Never load this fixture into an existing profile. CI reconstructs only isolated temporary databases; it never runs historical code or downloads a runtime. Git's LF attribute preserves the SQL digest across Windows/Linux checkouts.
