"""Keyless, offline release-input validation. Importing this module has no IO."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile

WEB_FILES = frozenset(f"saathi-web/{name}" for name in (
    "index.html", "app.js", "export.js", "help.js", "appointments.js",
    "plans.js", "media.js", "upload.js", "fixture.js", "style.css"))
CORE_FILES = frozenset({"app.js", "manifest.json", "LICENSE"}) | WEB_FILES | frozenset(
    f"examples/saathi/{name}.yaml" for name in
    ("agents", "brand", "channels", "knowledge", "model", "skills")) | frozenset(
    f"licenses/{name}" for name in
    ("hono-LICENSE", "zod-LICENSE", "yaml-LICENSE", "drizzle-orm-LICENSE", "bun-LICENSE.md"))
FIELDS = frozenset(("source", "dirty", "bun", "bundleSha256", "runtimeIntegrity",
                    "packages", "files", "fileSha256"))
MAX_FILE = 150_000_000
MAX_TOTAL = 200_000_000


def _deny():
    raise ValueError("Invalid or changed release inputs; rebuild and review the manifest.")


def _linked(path):
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def _read(root, name, limit):
    path = root
    for part in name.split("/"):
        path = path / part
        if _linked(path):
            _deny()
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        _deny()
    # Capture checked bytes once; archive creation never reopens mutable paths.
    with path.open("rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            _deny()
        value = file.read(limit + 1)
    if len(value) > limit:
        _deny()
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _deny()
        result[key] = value
    return result


def _load(build, require_runtime):
    build = Path(build).absolute()
    if any(_linked(path) for path in (build, *build.parents)) or not build.is_dir():
        _deny()
    raw = _read(build, "manifest.json", 1_000_000)
    try:
        manifest = json.loads(raw, object_pairs_hook=_unique_object,
                              parse_constant=lambda _: _deny())
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        _deny()
    if not isinstance(manifest, dict) or set(manifest) != FIELDS:
        _deny()
    if (manifest["dirty"] is not False or manifest["bun"] != "1.4.3"
            or not isinstance(manifest["source"], str)
            or not re.fullmatch("[0-9a-f]{40}", manifest["source"])):
        _deny()
    packages = manifest["packages"]
    if (not isinstance(packages, list) or not 1 <= len(packages) <= 100
            or any(not isinstance(p, str) or not 1 <= len(p) <= 200 for p in packages)
            or len(packages) != len(set(packages))):
        _deny()
    runtime = manifest["runtimeIntegrity"]
    has_runtime = runtime is not None
    if require_runtime and not has_runtime:
        _deny()
    expected = CORE_FILES | ({"linux-runtime.tgz"} if has_runtime else set())
    names, hashes = manifest["files"], manifest["fileSha256"]
    if (not isinstance(names, list) or any(not isinstance(n, str) for n in names)
            or len(names) != len(expected) or set(names) != expected
            or not isinstance(hashes, dict) or set(hashes) != expected - {"manifest.json"}
            or any(not isinstance(h, str) or not re.fullmatch("[0-9a-f]{64}", h) for h in hashes.values())
            or manifest["bundleSha256"] != hashes.get("app.js")):
        _deny()
    inputs = {"manifest.json": raw}
    total = len(raw)
    for name in names:
        if name == "manifest.json":
            continue
        data = _read(build, name, min(MAX_FILE, MAX_TOTAL - total))
        total += len(data)
        if hashlib.sha256(data).hexdigest() != hashes[name]:
            _deny()
        inputs[name] = data
    if has_runtime:
        actual = "sha512-" + base64.b64encode(hashlib.sha512(inputs["linux-runtime.tgz"]).digest()).decode()
        if runtime != actual:
            _deny()
    return manifest, inputs


def validate_build(build, *, require_runtime=True):
    """Check captured bytes; normal non-runtime builds need explicit check mode."""
    manifest, _ = _load(build, require_runtime)
    return manifest


def pack_release(build, archive, *, secret_values=()):
    """Atomically replace archive only after complete validation and secret scans.

    This checks the recorded runtime integrity; registry authenticity was checked
    by the builder. It is not a signature or proof of an approved source/release.
    """
    manifest, inputs = _load(build, True)
    secrets = [value.encode() for value in secret_values if value]
    if any(secret in data for data in inputs.values() for secret in secrets):
        raise ValueError("Credential found in release input.")
    archive = Path(archive)
    if archive.resolve().is_relative_to(Path(build).resolve()):
        _deny()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=archive.parent, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            with tarfile.open(fileobj=output, mode="w:gz") as packed:
                for name in manifest["files"]:
                    data = inputs[name]
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o644
                    packed.addfile(member, io.BytesIO(data))
        content = temporary.read_bytes()
        if any(secret in content for secret in secrets):
            raise ValueError("Credential found in release archive.")
        digest = hashlib.sha256(content).hexdigest()
        os.replace(temporary, archive)
        return manifest, digest
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Offline release input check; no keys or cloud access")
    parser.add_argument("build", type=Path)
    parser.add_argument("--check", action="store_true", help="Allow a normal build without Linux runtime; never pack it")
    args = parser.parse_args()
    validate_build(args.build, require_runtime=not args.check)
    print("Release inputs match the recorded manifest; no deployment performed.")
