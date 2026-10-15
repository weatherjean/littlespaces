#!/usr/bin/env python3
"""Exercise the release executable against synthetic data only."""
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "rust/target/release/little-spaces"


def main():
    with tempfile.TemporaryDirectory(prefix="littlespaces-release-") as temporary:
        workspace = Path(temporary) / "workspace"
        subprocess.run([BINARY, "init", workspace], check=True, capture_output=True)
        password = "synthetic-release-smoke-password"
        subprocess.run([BINARY, "owner-reset", workspace], input=password.encode(),
                       check=True, capture_output=True)
        subprocess.run([BINARY, "secret-put", workspace, "SMOKE_TOKEN"],
                       input=b"synthetic-backup-secret", check=True, capture_output=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env = {k: v for k, v in os.environ.items() if not k.startswith("LITTLESPACES_")}
        env.update(LITTLESPACES_ENABLE_LIVE_TESTS="1", LITTLESPACES_TEST_PROVIDER=origin)
        # The private setup link is deliberately captured, never printed.
        server = subprocess.Popen([BINARY, "serve", workspace, str(port)], env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(origin + "/api/session", timeout=1) as response:
                        assert json.load(response)["configured"] is True
                    break
                except (OSError, urllib.error.URLError):
                    assert server.poll() is None, "Release server exited during startup"
                    time.sleep(0.05)
            else:
                raise AssertionError("Release server did not become ready")
            for route in ["/api/test-runs", "/api/test-runs/synthetic/report"]:
                request = urllib.request.Request(origin + route,
                    data=b'{"allowRealModel":true}' if route == "/api/test-runs" else None,
                    headers={"content-type": "application/json"})
                try:
                    urllib.request.urlopen(request, timeout=2)
                    raise AssertionError("Release exposes live-test endpoint")
                except urllib.error.HTTPError as error:
                    assert error.code == 404, (route, error.code)
            assert not (workspace / "testing.key").exists()
            for route in ["/shell.js", "/applet.js", "/style.css"]:
                with urllib.request.urlopen(origin + route, timeout=2) as response:
                    assert len(response.read()) > 100
            request = urllib.request.Request(origin + "/api/login",
                data=json.dumps({"password": password}).encode(),
                headers={"origin": origin, "content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                cookie = response.headers["set-cookie"].split(";", 1)[0]
                assert json.load(response)["authenticated"]
            # Real process death releases the workspace lock. Copy only after
            # it exits; this is a synthetic offline backup/restore drill.
            server.kill()
            server.communicate(timeout=10)
            with sqlite3.connect(workspace / "workspace.sqlite") as db:
                db.execute("INSERT INTO jobs VALUES('cancelled-before-crash',NULL,NULL,'queued',?)",
                           (json.dumps({"cancelRequested": True}),))
            restored = Path(temporary) / "restored"
            subprocess.run([BINARY, "backup", workspace, restored], check=True, capture_output=True)
            assert (restored / "secrets.key").read_bytes() == (workspace / "secrets.key").read_bytes()
            with sqlite3.connect(restored / "workspace.sqlite") as db:
                assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            server = subprocess.Popen([BINARY, "serve", restored, str(port)], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for _ in range(100):
                try:
                    request = urllib.request.Request(origin + "/api/secrets", headers={"cookie": cookie})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        assert json.load(response) == [{"name": "SMOKE_TOKEN", "configured": True}]
                    break
                except (OSError, urllib.error.URLError):
                    assert server.poll() is None, "Restored server exited during startup"
                    time.sleep(0.05)
            else:
                raise AssertionError("Restored server did not become ready")
            with sqlite3.connect(restored / "workspace.sqlite") as db:
                assert db.execute("SELECT state FROM jobs WHERE id='cancelled-before-crash'").fetchone() == ("cancelled",)
            print("Release assets and test-route exclusion passed; synthetic crash, offline restore, owner session, secret metadata and cancellation recovery passed.")
        finally:
            server.send_signal(signal.SIGINT)
            try:
                server.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.communicate()


if __name__ == "__main__":
    main()
