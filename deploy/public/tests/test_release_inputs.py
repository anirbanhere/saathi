import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_inputs import pack_release, validate_build

WEB = ("index.html", "app.js", "export.js", "help.js", "appointments.js",
       "plans.js", "media.js", "upload.js", "fixture.js", "style.css")
FILES = ("app.js", "manifest.json", "LICENSE",
         *(f"examples/saathi/{name}.yaml" for name in
           ("agents", "brand", "channels", "knowledge", "model", "skills")),
         *(f"saathi-web/{name}" for name in WEB),
         *(f"licenses/{name}" for name in
           ("hono-LICENSE", "zod-LICENSE", "yaml-LICENSE", "drizzle-orm-LICENSE", "bun-LICENSE.md")))


class ReleaseInputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="saathi-release-inputs-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / "artifacts/public-build"
        self.build.mkdir(parents=True)
        self.archive = self.root / "release.tgz"
        self.manifest = {
            "source": "a" * 40, "dirty": False, "bun": "1.4.3",
            "bundleSha256": "", "runtimeIntegrity": None, "packages": ["zod@4.6.6"],
            "files": [*FILES, "linux-runtime.tgz"], "fileSha256": {},
        }
        for name in self.manifest["files"]:
            if name != "manifest.json":
                path = self.build / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"synthetic {name}".encode())
        self.pin()

    def pin(self):
        self.manifest["fileSha256"] = {
            name: hashlib.sha256((self.build / name).read_bytes()).hexdigest()
            for name in self.manifest["files"] if name != "manifest.json"
        }
        self.manifest["bundleSha256"] = self.manifest["fileSha256"]["app.js"]
        self.manifest["runtimeIntegrity"] = "sha512-" + base64.b64encode(
            hashlib.sha512((self.build / "linux-runtime.tgz").read_bytes()).digest()).decode()
        self.write()

    def write(self):
        (self.build / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def denied(self):
        with self.assertRaises(ValueError):
            pack_release(self.build, self.archive)
        self.assertFalse(self.archive.exists())

    def test_all_current_assets_pack_exactly_and_never_sweep_old_files(self):
        (self.build / "old.env").write_text("synthetic excluded", encoding="utf-8")
        manifest, digest = pack_release(self.build, self.archive)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(digest, hashlib.sha256(self.archive.read_bytes()).hexdigest())
        with tarfile.open(self.archive) as archive:
            self.assertEqual(archive.getnames(), self.manifest["files"])
            for item in archive.getmembers():
                self.assertTrue(item.isfile())
                self.assertEqual(archive.extractfile(item).read(), (self.build / item.name).read_bytes())

    def test_normal_build_is_checkable_but_cannot_be_packed_as_release(self):
        self.manifest["files"].remove("linux-runtime.tgz")
        self.manifest["fileSha256"].pop("linux-runtime.tgz")
        self.manifest["runtimeIntegrity"] = None
        self.write()
        self.assertEqual(validate_build(self.build, require_runtime=False), self.manifest)
        self.denied()

    def test_changed_static_or_runtime_bytes_are_rejected(self):
        for name in ("app.js", *(f"saathi-web/{n}" for n in WEB), "linux-runtime.tgz"):
            with self.subTest(name=name):
                path = self.build / name
                original = path.read_bytes()
                path.write_bytes(b"changed")
                self.denied()
                path.write_bytes(original)

    def test_unknown_noncanonical_duplicate_and_missing_names_are_rejected(self):
        for name in ("extra.js", "saathi-web/extra.js", "examples/saathi/extra.yaml",
                     "../app.js", "/app.js", "C:/app.js", "saathi-web\\help.js",
                     "saathi-web/./help.js", "saathi-web//help.js", "app.js"):
            with self.subTest(name=name):
                self.manifest["files"].append(name)
                self.write()
                self.denied()
                self.manifest["files"].pop()
        self.manifest["files"].remove("saathi-web/help.js")
        self.manifest["fileSha256"].pop("saathi-web/help.js")
        self.write()
        self.denied()

    def test_missing_files_and_directories_are_rejected(self):
        path = self.build / "saathi-web/help.js"
        path.unlink()
        self.denied()
        path.mkdir()
        self.denied()

    def test_file_symlink_is_rejected_even_with_valid_bytes(self):
        path = self.build / "saathi-web/help.js"
        original = path.read_bytes()
        path.unlink()
        outside = self.root / "outside.js"
        outside.write_bytes(original)
        try:
            path.symlink_to(outside)
        except OSError:
            self.skipTest("File symlinks unavailable on this platform")
        self.denied()

    def test_parent_directory_symlink_is_rejected_even_with_valid_bytes(self):
        directory = self.build / "saathi-web"
        moved = self.root / "web"
        directory.rename(moved)
        try:
            directory.symlink_to(moved, target_is_directory=True)
        except OSError:
            moved.rename(directory)
            self.skipTest("Directory symlinks unavailable on this platform")
        self.denied()

    def test_build_ancestor_symlink_is_rejected_even_with_valid_bytes(self):
        ancestor = self.root / "artifacts"
        moved = self.root / "moved-artifacts"
        ancestor.rename(moved)
        try:
            ancestor.symlink_to(moved, target_is_directory=True)
        except OSError:
            moved.rename(ancestor)
            self.skipTest("Directory symlinks unavailable on this platform")
        self.denied()

    def test_hash_set_and_digest_shapes_are_strict(self):
        for edit in (lambda m: m["fileSha256"].pop("saathi-web/help.js"),
                     lambda m: m["fileSha256"].update({"manifest.json": "a" * 64}),
                     lambda m: m["fileSha256"].update({"app.js": "A" * 64}),
                     lambda m: m.update(bundleSha256="a" * 64),
                     lambda m: m.update(runtimeIntegrity="sha512-" + "A" * 88)):
            with self.subTest(edit=edit):
                original = json.loads(json.dumps(self.manifest))
                edit(self.manifest)
                self.write()
                self.denied()
                self.manifest = original

    def test_manifest_shape_dirty_source_runtime_and_old_manifest_are_rejected(self):
        for field, value in (("dirty", True), ("dirty", 0), ("source", "main"),
                             ("source", "A" * 40), ("bun", "latest"),
                             ("runtimeIntegrity", None), ("files", {}),
                             ("packages", "zod@4.6.6"), ("fileSha256", {})):
            with self.subTest(field=field, value=value):
                original = self.manifest[field]
                self.manifest[field] = value
                self.write()
                self.denied()
                self.manifest[field] = original
        self.manifest.pop("fileSha256")
        self.write()
        self.denied()

    def test_duplicate_json_keys_and_oversized_manifest_are_rejected(self):
        path = self.build / "manifest.json"
        path.write_text('{"dirty":false,"dirty":true}', encoding="utf-8")
        self.denied()
        path.write_bytes(b" " * (1_000_000 + 1))
        self.denied()

    def test_secret_scan_is_fixed_and_preserves_previous_archive_on_failure(self):
        secret = "synthetic-provider-value"
        (self.build / "saathi-web/help.js").write_text(secret, encoding="utf-8")
        self.pin()
        self.archive.write_bytes(b"previous release")
        with self.assertRaises(ValueError) as error:
            pack_release(self.build, self.archive, secret_values=[secret])
        self.assertNotIn(secret, str(error.exception))
        self.assertEqual(self.archive.read_bytes(), b"previous release")
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_pack_captures_checked_bytes_instead_of_reopening_paths(self):
        path = self.build / "saathi-web/help.js"
        original = path.read_bytes()
        real_open = tarfile.open

        def replace_after_capture(*args, **kwargs):
            path.write_bytes(b"late local change")
            return real_open(*args, **kwargs)

        with mock.patch("release_inputs.tarfile.open", side_effect=replace_after_capture):
            pack_release(self.build, self.archive)
        with real_open(self.archive) as archive:
            self.assertEqual(archive.extractfile("saathi-web/help.js").read(), original)

    def test_output_cannot_replace_a_build_input(self):
        path = self.build / "app.js"
        original = path.read_bytes()
        with self.assertRaises(ValueError):
            pack_release(self.build, path)
        self.assertEqual(path.read_bytes(), original)

    def test_operator_rejects_invalid_build_before_reading_profile_or_cloud(self):
        specification = importlib.util.spec_from_file_location(
            "operator_deploy_under_test", Path(__file__).resolve().parents[1] / "deploy.py")
        module = importlib.util.module_from_spec(specification)
        with mock.patch("shutil.which", return_value="unused-gcloud"):
            specification.loader.exec_module(module)
        module.ROOT = self.root
        self.manifest["dirty"] = True
        self.write()
        with mock.patch.object(module, "cloud", side_effect=AssertionError("cloud called")) as cloud:
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("profile read")) as profile:
                with self.assertRaises(ValueError):
                    module.main()
                profile.assert_not_called()
            cloud.assert_not_called()


if __name__ == "__main__":
    unittest.main()
