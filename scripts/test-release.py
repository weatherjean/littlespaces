#!/usr/bin/env python3
"""Synthetic release packaging regressions; no build, network, or private data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package-release.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "package"
        for name in package.PUBLIC_FILES + ["rust/target/test-host/release/little-spaces"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic public input\n")
        (self.root / "rust/target/test-host/release/little-spaces").chmod(0o755)
        self.notices = self.root / "build-rust/notices"
        self.notices.mkdir(parents=True)
        (self.notices / "NOTICE.txt").write_text("synthetic notice\n")
        (self.notices / "README.txt").write_text("notice inventory\n")
        (self.notices / "Rust.html").write_text("synthetic standard-library notices")
        self.inventory = {
            "toolchain": {"rustc": "host: test-host\n", "path": "Rust.html", "sha256": self.digest(self.notices / "Rust.html")},
            "target": "test-host",
            "lockfiles": {name: self.digest(self.root / name) for name in
                          ("rust/Cargo.lock", "web/package-lock.json")},
            "native": {"path": "NOTICE.txt", "sha256": self.digest(self.notices / "NOTICE.txt")},
            "packages": [],
        }

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def run_package(self):
        (self.notices / "manifest.json").write_text(json.dumps(self.inventory))
        with patch.object(package, "ROOT", self.root), patch.object(sys, "argv", ["package-release.py", str(self.target)]), patch.object(package.subprocess, "check_output", side_effect=["host: test-host\n", "abc123\n", ""]):
            with patch.object(package.subprocess, "run") as build:
                self.build = build
                package.main()

    def rejects_before_output(self):
        with self.assertRaises(SystemExit):
            self.run_package()
        self.assertFalse(self.target.exists())
        self.build.assert_not_called()

    def test_package_excludes_unlisted_files_and_checksums_every_output(self):
        (self.root / "licenses/private.txt").write_text("do not ship")
        (self.notices / "private.txt").write_text("do not ship")
        self.run_package()
        self.assertFalse((self.target / "licenses/private.txt").exists())
        self.assertFalse((self.target / "third-party/private.txt").exists())
        self.assertEqual((self.target / "little-spaces").stat().st_mode & 0o111, 0o111)
        lines = (self.target / "SHA256SUMS").read_text().splitlines()
        for line in lines:
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, self.digest(self.target / name))
        self.assertEqual(len(lines), len([p for p in self.target.rglob("*") if p.is_file()]) - 1)

    def test_rebuilds_locked_inputs_and_copies_explicit_target(self):
        stale = self.root / "rust/target/release/little-spaces"
        stale.parent.mkdir(parents=True)
        stale.write_text("stale binary must not ship")
        self.run_package()
        self.assertEqual([call.args[0][:3] for call in self.build.call_args_list],
                         [["npm", "ci", "--prefix"], ["npm", "run", "build"],
                          ["cargo", "build", "--manifest-path"]])
        command = self.build.call_args_list[-1].args[0]
        self.assertIn("--locked", command)
        self.assertEqual(command[command.index("--target") + 1], "test-host")
        self.assertEqual(command[command.index("--target-dir") + 1], str(self.root / "rust/target"))
        self.assertNotEqual((self.target / "little-spaces").read_bytes(), stale.read_bytes())
        self.assertEqual(json.loads((self.target / "release.json").read_text())["target"], "test-host")

    def test_build_failure_prevents_package(self):
        self.inventory["target"] = "test-host"
        with patch.object(package.subprocess, "run", side_effect=RuntimeError("build failed")):
            # run_package normally mocks builds; invoke main directly here.
            (self.notices / "manifest.json").write_text(json.dumps(self.inventory))
            with patch.object(package, "ROOT", self.root), patch.object(sys, "argv", ["package-release.py", str(self.target)]), patch.object(package.subprocess, "check_output", return_value="host: test-host\n"):
                with self.assertRaises(RuntimeError):
                    package.main()
        self.assertFalse(self.target.exists())

    def test_missing_standard_library_notices(self):
        del self.inventory["toolchain"]
        self.rejects_before_output()

    def test_changed_toolchain(self):
        self.inventory["toolchain"]["rustc"] = "another compiler"
        self.rejects_before_output()

    def test_altered_standard_library_notice(self):
        (self.notices / "Rust.html").write_text("altered")
        self.rejects_before_output()

    def test_stale_lockfile(self):
        self.inventory["lockfiles"]["rust/Cargo.lock"] = "wrong"
        self.rejects_before_output()

    def test_wrong_target(self):
        self.inventory["target"] = "other-host"
        self.rejects_before_output()

    def test_tampered_notice(self):
        (self.notices / "NOTICE.txt").write_text("changed")
        self.rejects_before_output()

    def test_notice_traversal_even_when_it_resolves_inside_bundle(self):
        self.inventory["native"]["path"] = "../notices/NOTICE.txt"
        self.rejects_before_output()

    def test_notice_symlink(self):
        path = self.notices / "NOTICE.txt"
        path.unlink()
        path.symlink_to(self.root / "LICENSE")
        self.inventory["native"]["sha256"] = self.digest(path)
        self.rejects_before_output()

    def test_public_input_symlink(self):
        path = self.root / "LICENSE"
        path.unlink()
        path.symlink_to(self.root / "README.md")
        self.rejects_before_output()

    def test_duplicate_notice(self):
        self.inventory["packages"] = [{"notices": [self.inventory["native"]]}]
        self.rejects_before_output()

    def test_missing_public_input(self):
        (self.root / "LICENSE").unlink()
        self.rejects_before_output()

    def test_existing_destination_is_preserved(self):
        self.target.mkdir()
        marker = self.target / "keep"
        marker.write_text("existing")
        with self.assertRaises(FileExistsError):
            self.run_package()
        self.assertEqual(marker.read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
