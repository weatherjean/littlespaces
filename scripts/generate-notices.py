#!/usr/bin/env python3
"""Collect original dependency notices for the local release target; fail on gaps."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SUPPLEMENTS = {
    ("jsonschema", "0.26.2"): "JSONSCHEMA-MIT.txt",
    ("referencing", "0.26.2"): "JSONSCHEMA-MIT.txt",
    ("rhai_codegen", "3.2.0"): "RHAI-CODEGEN-MIT.txt",
    ("uuid-simd", "0.8.0"): "SIMD-MIT.txt",
    ("vsimd", "0.8.0"): "SIMD-MIT.txt",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def notice_files(directory):
    return sorted(p for p in directory.rglob("*") if p.is_file()
                  and (p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE"))
                       or p.name.upper() in ("THIRDPARTYNOTICES.TXT", "THIRD-PARTY-NOTICES.MD")))


def generate(destination, native_notice):
    target = next(line.split(": ", 1)[1] for line in subprocess.check_output(
        ["rustc", "-vV"], text=True).splitlines() if line.startswith("host: "))
    metadata = json.loads(subprocess.check_output([
        "cargo", "metadata", "--manifest-path", str(ROOT / "rust/Cargo.toml"),
        "--locked", "--format-version", "1", "--filter-platform", target,
    ], cwd=ROOT, text=True))
    entries = []
    sources = {}
    missing = []
    for package in metadata["packages"]:
        if not package.get("source"):
            continue
        name, version = package["name"], package["version"]
        sources[("cargo", name, version)] = f"https://crates.io/api/v1/crates/{name}/{version}/download"
        base = Path(package["manifest_path"]).parent
        files = notice_files(base)
        supplement = SUPPLEMENTS.get((name, version))
        if not files and supplement:
            base = ROOT / "licenses/upstream"
            files = [base / supplement]
        entries.append(("cargo", name, version, package.get("license"), base, files))

    lock = json.loads((ROOT / "web/package-lock.json").read_text())
    for relative, package in lock["packages"].items():
        if not relative:
            continue
        base = ROOT / "web" / relative
        manifest = base / "package.json"
        if not manifest.exists():
            if package.get("optional"):
                continue  # Other platforms' optional build executables are not shipped.
            raise RuntimeError(f"Install web dependencies first: {relative}")
        installed = json.loads(manifest.read_text())
        name, version = installed["name"], installed["version"]
        sources[("npm", name, version)] = package["resolved"]
        if version != package["version"]:
            raise RuntimeError(f"Installed version differs from lockfile: {name}")
        files = notice_files(base)
        if not files and name.startswith("@esbuild/"):
            base = ROOT / "web/node_modules/esbuild"
            parent = json.loads((base / "package.json").read_text())
            if parent["version"] != version:
                raise RuntimeError("esbuild executable and wrapper versions differ")
            files = notice_files(base)
        entries.append(("npm", name, version, installed.get("license"), base, files))

    for ecosystem, name, version, license_id, base, files in entries:
        if not license_id or not files or any(not p.is_file() for p in files):
            missing.append(f"{ecosystem}:{name}@{version}")
    if missing:
        raise RuntimeError("Missing license metadata/text: " + ", ".join(missing))
    if not native_notice.is_file() or native_notice.stat().st_size == 0:
        raise RuntimeError("Provide the installed OpenSSL distribution's license/copyright file")

    destination.mkdir(parents=True, exist_ok=False)
    inventory = []
    for ecosystem, name, version, license_id, base, files in entries:
        folder = destination / ecosystem / (name.replace("/", "_") + "-" + version)
        copied = []
        for source in files:
            relative = source.relative_to(base)
            output = folder / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, output)
            copied.append({"path": str(output.relative_to(destination)), "sha256": digest(output)})
        inventory.append({"ecosystem": ecosystem, "name": name, "version": version,
                          "license": license_id, "sourceUrl": sources[(ecosystem, name, version)],
                          "notices": copied})
    native = destination / "OpenSSL-NOTICE.txt"
    shutil.copy2(native_notice, native)
    (destination / "manifest.json").write_text(json.dumps({
        "target": target,
        "lockfiles": {p: digest(ROOT / p) for p in ("rust/Cargo.lock", "web/package-lock.json")},
        "native": {"name": "OpenSSL", "path": native.name, "sha256": digest(native)},
        "packages": sorted(inventory, key=lambda p: (p["ecosystem"], p["name"], p["version"])),
    }, indent=2) + "\n")
    (destination / "README.txt").write_text(
        "Original dependency license/notice texts for the recorded target and lockfiles.\n"
        "Includes Cargo build/test dependencies and installed web build/verifier tools,\n"
        "so this inventory is broader than the code linked into the host binary.\n"
        "Unmodified upstream source archives are linked by sourceUrl for every package,\n"
        "including the MPL-licensed ece and smartstring crates.\n"
        "SQLite's bundled source is public domain; its source header records that status.\n"
        "Node and downloaded browsers are installed separately and are not bundled here.\n"
        "OpenSSL notice is supplied from the build host's installed distribution.\n"
        "Supplement provenance is recorded in licenses/upstream/SOURCES.md in the source/package.\n"
    )
    print(f"Collected notices for {len(inventory)} packages and OpenSSL ({target})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="New output directory")
    parser.add_argument("--openssl-notice", type=Path, required=True)
    args = parser.parse_args()
    generate(args.destination, args.openssl_notice)
