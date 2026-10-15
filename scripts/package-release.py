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
    target.mkdir(parents=True, exist_ok=False)
    shutil.copy2(binary, target / "little-spaces")
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "rust/Cargo.lock",
                 "web/package.json", "web/package-lock.json", "web/browser-harness.mjs",
                 "deploy/README.md", "deploy/production.env.example", "deploy/traefik.yml",
                 "deploy/traefik-dynamic.yml", "deploy/systemd/littlespaces.service",
                 "deploy/systemd/littlespaces-browser.service", "deploy/systemd/traefik.service"]:
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, output)
    for name in ["licenses"]:
        shutil.copytree(ROOT / name, target / name)
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
