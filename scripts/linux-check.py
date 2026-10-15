#!/usr/bin/env python3
"""Stage only source/public assets, then test inside an isolated Linux container."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="littlespaces-linux-check-") as directory:
    stage = Path(directory)
    for relative in ("rust/src", "rust/tests", "web/core", "docs/rhai", "examples", "static", "build-rust/core"):
        shutil.copytree(ROOT / relative, stage / relative)
    for name in ("Cargo.toml", "Cargo.lock", "build.rs"):
        shutil.copy2(ROOT / "rust" / name, stage / "rust" / name)
    shutil.copy2(ROOT / "deploy/Dockerfile.test", stage / "Dockerfile")
    subprocess.run(["docker", "build", "-t", "little-spaces-review-tests", str(stage)], check=True)
subprocess.run(["docker", "run", "--rm", "--network", "none", "--memory", "2g", "--cpus", "2", "little-spaces-review-tests"], check=True)
