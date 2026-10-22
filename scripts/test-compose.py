#!/usr/bin/env python3
"""Test the production Compose images in a disposable local project; no real account needed."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="Build images before testing")
    parser.add_argument("--app-image", default="ghcr.io/weatherjean/littlespaces:local")
    parser.add_argument("--verifier-image", default="ghcr.io/weatherjean/littlespaces-verifier:local")
    args = parser.parse_args()
    project = "littlespaces-smoke-" + secrets.token_hex(4)
    port, callback_port = free_port(), free_port()
    origin = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="littlespaces-compose-") as temporary:
        stage = Path(temporary)
        token = stage / "browser_token"
        token.write_text(secrets.token_hex(32) + "\n")
        token.chmod(0o444)
        # The containing directory remains private; only synthetic secrets exist here.
        settings = stage / "settings.env"
        settings.write_text(
            f"LITTLESPACES_PUBLIC_URL={origin}\nLITTLESPACES_HOST=127.0.0.1\n"
            f"LITTLESPACES_AUTHORITY=127.0.0.1:{port}\nLITTLESPACES_PORT={port}\n"
            f"LITTLESPACES_BROWSER_TOKEN_FILE={token}\n"
            f"LITTLESPACES_APP_IMAGE={args.app_image}\n"
            f"LITTLESPACES_VERIFIER_IMAGE={args.verifier_image}\n"
        )
        override = stage / "ports.json"
        override.write_text(json.dumps({"services": {"gateway": {"ports": [
            f"127.0.0.1:{port}:{port}", f"127.0.0.1:{callback_port}:1455"
        ]}}}))
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("COMPOSE_", "LITTLESPACES_", "TAILSCALE_"))}
        base = ["docker", "compose", "--project-name", project, "--env-file", str(settings),
                "-f", str(ROOT / "compose.yaml"), "-f", str(override)]

        def compose(*command, input=None):
            result = subprocess.run(base + list(command), cwd=ROOT, env=env,
                                    input=input, text=True, capture_output=True)
            if result.returncode:
                # Do not print service logs: they contain a private owner-setup token.
                raise RuntimeError(f"Compose {' '.join(command[:3])} failed: {result.stderr[-2000:]}")
            return result.stdout

        cookies = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
        csrf = ""

        def request(route, body=None, headers=None):
            h = {"origin": origin, "x-csrf-token": csrf}
            h.update(headers or {})
            if body is not None:
                h["content-type"] = "application/json"
            req = urllib.request.Request(origin + route, headers=h,
                                         data=None if body is None else json.dumps(body).encode())
            try:
                with client.open(req, timeout=120) as response:
                    raw = response.read()
                    return response.status, json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        def api(route, body=None):
            status, value = request(route, body)
            assert status == 200, (route, status, value)
            return value

        def ready():
            for _ in range(90):
                try:
                    status, _ = request("/health/ready")
                    if status == 200:
                        return
                except (OSError, ValueError):
                    pass
                time.sleep(1)
            raise AssertionError("Container stack did not become ready")

        try:
            if args.build:
                print("Building production images…", flush=True)
                compose("build")
            print("Starting isolated production stack…", flush=True)
            compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180")
            ready()
            ids = compose("ps", "-q").split()
            details = json.loads(subprocess.check_output(["docker", "inspect", *ids], text=True))
            for container in details:
                assert not container["HostConfig"]["Privileged"]
                assert container["HostConfig"]["ReadonlyRootfs"]
                assert container["HostConfig"]["Memory"] > 0
                assert container["HostConfig"]["PidsLimit"] > 0
                assert not any(m["Destination"] == "/var/run/docker.sock" for m in container["Mounts"])
            assert compose("exec", "-T", "app", "id", "-u").strip() == "10001"
            assert compose("exec", "-T", "verifier", "id", "-u").strip() == "10002"
            assert request("/api/apps")[0] == 401
            assert request("/api/test-runs", {"allowRealModel": True})[0] == 404
            assert request("/api/session", headers={"Host": "attacker.invalid"})[0] == 404
            # The callback tunnel is not a second route into the owner API.
            callback_client = urllib.request.build_opener()
            for route, expected in [("/api/session", 404), ("/auth/callback?error=access_denied", 400)]:
                req = urllib.request.Request(f"http://127.0.0.1:{callback_port}{route}",
                                             headers={"Host": "127.0.0.1:1455"})
                try:
                    callback_client.open(req, timeout=10)
                    raise AssertionError("Callback listener accepted an invalid request")
                except urllib.error.HTTPError as error:
                    assert error.code == expected, (route, error.code)
            logs = compose("logs", "--no-color", "app")
            setup = re.search(r"/#setup=(\S+)", logs)
            assert setup, "First start must offer owner setup"
            password = secrets.token_urlsafe(32)
            api("/api/setup", {"token": setup.group(1), "email": "owner@example.test", "password": password})
            csrf = api("/api/login", {"email": "owner@example.test", "password": password})["csrf"]
            app = api("/api/apps", {"title": "Container smoke"})
            session = app["conversation"]
            code = json.loads((ROOT / "examples/tasks-rhai.json").read_text())
            draft = api(f"/api/authoring/{session}", {"tool": "read_draft"})
            edited = api(f"/api/authoring/{session}", {
                "tool": "edit_draft", "expected_version": draft["version"], "code": code})
            released = api(f"/api/authoring/{session}", {
                "tool": "release", "expected_version": edited["version"],
                "sql": [], "records": {}, "probes": []})
            assert released.get("published"), released
            detail = api(f"/api/apps/{app['app']}")
            revision = detail["revision"]["id"]
            api("/api/action", {"id": secrets.token_hex(16), "app": app["app"],
                               "revision": revision, "action": "add",
                               "input": {"key": "persistent", "title": "Survives restart"},
                               "mode": "commit"})
            original = api(f"/api/apps/{app['app']}")["records"]
            assert original["persistent"]["title"] == "Survives restart"
            # A failed new revision must leave the last published app and data intact.
            broken = json.loads(json.dumps(code))
            broken["tests"][0]["expected"] = {"deliberately": "incorrect"}
            failed_draft = api(f"/api/authoring/{session}", {
                "tool": "edit_draft", "expected_version": edited["version"], "code": broken})
            status, failure = request(f"/api/authoring/{session}", {
                "tool": "release", "expected_version": failed_draft["version"],
                "sql": [], "records": {}, "probes": []})
            assert status != 200 or not failure.get("published"), failure
            unchanged = api(f"/api/apps/{app['app']}")
            assert unchanged["revision"]["id"] == revision and unchanged["records"] == original
            print("Sandboxed browser validation and publication passed.", flush=True)
            compose("restart", "app")
            ready()
            assert api(f"/api/apps/{app['app']}")["records"] == original
            compose("stop", "verifier")
            for _ in range(30):
                if request("/health/ready")[0] == 503:
                    break
                time.sleep(1)
            else:
                raise AssertionError("Missing verifier must fail readiness")
            compose("start", "verifier")
            ready()
            compose("stop", "app")
            compose("run", "--rm", "--no-deps", "app", "backup",
                    "/data/workspace", "/data/backup-smoke")
            compose("run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "app",
                    "-c", "cp -a /data/backup-smoke /data/restored")
            restore = stage / "restore.json"
            restore.write_text(json.dumps({"services": {"app": {
                "command": ["serve", "/data/restored", "5175"]}}}))
            base.extend(["-f", str(restore)])
            compose("up", "-d", "--no-deps", "app")
            ready()
            assert api(f"/api/apps/{app['app']}")["records"] == original
            codes = [request("/api/login", {"password": "deliberately-wrong"}, headers={
                "X-Forwarded-For": f"198.51.100.{i}", "X-Real-IP": f"198.51.100.{i}"
            })[0] for i in range(1, 5)]
            assert codes[-1] == 429, "Spoofed client headers bypassed the login rate limit"
            print("Restart, verifier outage/recovery, and backup/restore passed.", flush=True)
            print("Production Compose smoke passed; no ChatGPT credentials were used.", flush=True)
        finally:
            # Only this script's random, disposable project and synthetic volumes.
            compose("down", "--volumes", "--remove-orphans", "--timeout", "40")


if __name__ == "__main__":
    main()
