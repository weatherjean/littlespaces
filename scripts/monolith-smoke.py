#!/usr/bin/env python3
"""Synthetic fresh-workspace author/test/publish/action smoke. No model calls."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "rust/target/debug/little-spaces"


def main():
    with tempfile.TemporaryDirectory(prefix="littlespaces-core-") as temporary:
        workspace = str(Path(temporary) / "workspace")

        def run(*arguments):
            result = subprocess.run(
                [str(BINARY), *arguments], check=True, text=True, capture_output=True
            )
            return json.loads(result.stdout)

        run("init", workspace)
        app = run("create", workspace, "Tasks", str(ROOT / "examples/tasks-rhai.json"))
        run("test", workspace, app["app"], app["revision"])
        run("publish", workspace, app["app"], app["revision"])
        parameters = (workspace, app["app"], app["revision"])
        run("dry-run", *parameters, "add", '{"key":"dry","title":"Do not save"}')
        assert run("run", *parameters, "list", "{}")["result"]["result"] == []
        run("run", *parameters, "add", '{"key":"keep","title":"Keep"}')
        assert run("run", *parameters, "list", "{}")["result"]["result"] == [
            {"key": "keep", "value": {"title": "Keep", "done": False}}
        ]
        print("Persisted backend app smoke passed; no frontend or model milestone claimed.")


if __name__ == "__main__":
    main()
