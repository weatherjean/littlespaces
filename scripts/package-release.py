#!/usr/bin/env python3
"""Package an already-built release using an explicit public-file allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "CONTRIBUTING.md",
                 "SECURITY.md", "CONTEXT.md", "docs/releasing.md", "docs/release-review-2026-10-16.md", "docs/production-readiness.md",
                 "docs/monolith-rework.md", "docs/rhai/sdk.md", "docs/rhai/frontend.md",
                 "docs/rhai/status.md", "docs/rhai/sign-in.md", "rust/Cargo.lock",
                 "web/package.json", "web/package-lock.json", "web/browser-harness.mjs",
                 "deploy/README.md", "deploy/production.env.example", "deploy/traefik.yml",
                 "deploy/traefik-dynamic.yml", "deploy/systemd/littlespaces.service",
                 "deploy/systemd/littlespaces-browser.service", "deploy/systemd/traefik.service"] + ["licenses/HTM.txt", "licenses/MARKED.txt", "licenses/PREACT.txt",
                 "licenses/RHAI-APACHE.txt", "licenses/RHAI-MIT.txt",
                 "licenses/upstream/JSONSCHEMA-MIT.txt", "licenses/upstream/RHAI-CODEGEN-MIT.txt",
                 "licenses/upstream/SIMD-MIT.txt", "licenses/upstream/SOURCES.md"]

def regular_file(base, name):
    """Reject aliases and traversal before copying any release input."""
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts or str(relative) != name:
        raise SystemExit("Release input must be a relative path without traversal")
    path = base / relative
    if base.is_symlink() or any(p.is_symlink() for p in [path, *path.parents] if p != base and base in p.parents):
        raise SystemExit("Release inputs must not be symbolic links")
    if not path.is_file():
        raise SystemExit(f"Missing release input: {name}")
    return path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="New package directory")
    parser.add_argument("--notices", type=Path, default=ROOT / "build-rust/notices",
                        help="Generated notice inventory (default: build-rust/notices)")
    args = parser.parse_args()
    target = args.destination.resolve()
    binary = ROOT / "rust/target/release/little-spaces"
    if not binary.is_file():
        raise SystemExit("Build the release executable first")
    notices = args.notices.absolute()
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
    paths = [item["path"] for item in notice_files]
    if len(paths) != len(set(paths)) or set(paths) & {"manifest.json", "README.txt"}:
        raise SystemExit("Notice bundle contains duplicate or reserved paths")
    for item in notice_files:
        source = regular_file(notices, item["path"])
        if hashlib.sha256(source.read_bytes()).hexdigest() != item["sha256"]:
            raise SystemExit("Notice bundle failed its path/checksum validation")
    for name in PUBLIC_FILES + ["rust/target/release/little-spaces"]:
        regular_file(ROOT, name)
    for name in ["manifest.json", "README.txt"]:
        regular_file(notices, name)
    target.mkdir(parents=True, exist_ok=False)
    shutil.copy2(binary, target / "little-spaces")
    for name in PUBLIC_FILES:
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, output)
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
