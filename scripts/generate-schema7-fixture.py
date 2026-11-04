"""Optional offline regeneration from pinned historical code; never opens app profiles.

Requires the pinned Git object, Python stdlib, Bun and installed local dependencies.
Normal CI consumes the reviewed text fixture and does not execute historical code.
"""
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "27de0986f21098a5173061000ba97a02ab01a3a5"
PREFIX = "openbot/server/src/self-hosted/"
MODULES = ("store.ts", "appointments.ts", "errors.ts", "plan-reads.ts",
           "plans.ts", "plan-contract.ts", "roles.ts", "config.ts")


def main():
    if sys.argv[1:] not in ([], ["--verify-upgrade"]):
        raise RuntimeError("Only --verify-upgrade is supported")
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("Install the repository's pinned Bun first")
    # Kept below server so historical modules resolve the installed zod package.
    base = ROOT / "openbot/server/artifacts"
    base.mkdir(parents=True, exist_ok=True)
    output = ROOT / "openbot/server/tests/fixtures/schema7"
    with tempfile.TemporaryDirectory(prefix="schema7-source-", dir=base) as folder:
        work = Path(folder).resolve()
        if work.parent != base.resolve() or not work.name.startswith("schema7-source-"):
            raise RuntimeError("Unexpected synthetic fixture directory")
        blobs = {}
        for name in MODULES:
            reference = f"{SOURCE}:{PREFIX}{name}"
            data = subprocess.check_output(["git", "show", reference], cwd=ROOT)
            (work / name).write_bytes(data)
            blobs[name] = hashlib.sha256(data).hexdigest()
        # No inherited provider/configuration environment or automatic .env load.
        env = {k: v for k, v in os.environ.items()
               if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"}}
        path, seed = work / "synthetic.sqlite", work / "seed.json"
        command = [bun, "--no-env-file", str(ROOT / "scripts/fixtures/schema7-seed.ts"),
                   str(work), str(path), str(seed)]
        if "--verify-upgrade" in sys.argv[1:]:
            command.append(str(ROOT / "openbot/server/src/self-hosted/store.ts"))
        subprocess.run(command, cwd=ROOT, env=env, check=True)
        # Historical store is closed: capture its complete consistent SQL, not a
        # current-schema database with a rewritten version. No WAL is omitted.
        with closing(sqlite3.connect(path)) as db:
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise RuntimeError("Invalid generated synthetic database")
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("Invalid historical foreign keys")
            sql = "\n".join(db.iterdump()) + "\n"
        metadata = {"source": SOURCE, "source_sha256": blobs,
                    "sha256": hashlib.sha256(sql.encode()).hexdigest(),
                    "seed": json.loads(seed.read_text(encoding="utf-8"))}
        output.mkdir(parents=True, exist_ok=True)
        (output / "snapshot.sql").write_text(sql, encoding="utf-8", newline="\n")
        (output / "provenance.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("Generated closed synthetic schema7 text fixture; no profile/provider access.")


if __name__ == "__main__":
    main()
