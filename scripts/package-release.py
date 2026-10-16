#!/usr/bin/env python3
"""Package an already-built release using an explicit public-file allowlist."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def main():
    target = Path(sys.argv[1]).resolve()
    binary = ROOT / "rust/target/release/little-spaces"
    if not binary.is_file():
        raise SystemExit("Build the release executable first")
    notices = ROOT / "build-rust/notices"
    if not (notices / "manifest.json").is_file():
        raise SystemExit("Generate build-rust/notices with scripts/generate-notices.py first")
    inventory = json.loads((notices / "manifest.json").read_text())
    host = next(line.split(": ", 1)[1] for line in subprocess.check_output(
        ["rustc", "-vV"], text=True).splitlines() if line.startswith("host: "))
    if inventory["target"] != host:
        raise SystemExit("Notice bundle target differs from the local release target")
    for name in ("rust/Cargo.lock", "web/package-lock.json"):
        if inventory["lockfiles"].get(name) != hashlib.sha256((ROOT / name).read_bytes()).hexdigest():
            raise SystemExit("Notice bundle is stale; regenerate it for the current lockfiles")
    notice_files = [inventory["native"]] + [file for package in inventory["packages"] for file in package["notices"]]
    for item in notice_files:
        source = (notices / item["path"]).resolve()
        if not source.is_relative_to(notices.resolve()) or hashlib.sha256(source.read_bytes()).hexdigest() != item["sha256"]:
            raise SystemExit("Notice bundle failed its path/checksum validation")
    target.mkdir(parents=True, exist_ok=False)
    shutil.copy2(binary, target / "little-spaces")
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "CONTRIBUTING.md",
                 "SECURITY.md", "CONTEXT.md", "docs/releasing.md", "docs/release-review-2026-10-16.md", "docs/production-readiness.md",
                 "docs/monolith-rework.md", "docs/rhai/sdk.md", "docs/rhai/frontend.md",
                 "docs/rhai/status.md", "docs/rhai/sign-in.md", "rust/Cargo.lock",
                 "web/package.json", "web/package-lock.json", "web/browser-harness.mjs",
                 "deploy/README.md", "deploy/production.env.example", "deploy/traefik.yml",
                 "deploy/traefik-dynamic.yml", "deploy/systemd/littlespaces.service",
                 "deploy/systemd/littlespaces-browser.service", "deploy/systemd/traefik.service"]:
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, output)
    for name in ["licenses"]:
        shutil.copytree(ROOT / name, target / name)
    for name in ["manifest.json", "README.txt"] + [item["path"] for item in notice_files]:
        output = target / "third-party" / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(notices / name, output)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT, text=True))
    (target / "release.json").write_text(json.dumps({"commit": commit, "dirty": dirty,
        "platform": platform.system(), "architecture": platform.machine()}, indent=2) + "\n")
    checksums = []
    for path in sorted(target.rglob("*")):
        if path.is_file():
            checksums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(target)}\n")
    (target / "SHA256SUMS").write_text("".join(checksums))
    print(f"Packaged {len(checksums)} public files for {platform.system()}/{platform.machine()}")

if __name__ == "__main__":
    main()
