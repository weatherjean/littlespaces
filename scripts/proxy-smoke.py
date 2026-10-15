#!/usr/bin/env python3
"""Check the deployment templates without public networking or certificate issuance.

Requires Docker and PyYAML (CI pins the latter). No credentials are mounted.
"""
from pathlib import Path
import subprocess
import tempfile
import time

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "traefik:3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c"


def main():
    with tempfile.TemporaryDirectory(prefix="littlespaces-traefik-") as directory:
        stage = Path(directory)
        config = yaml.safe_load((ROOT / "deploy/traefik.yml").read_text())
        config.pop("certificatesResolvers")
        dynamic = yaml.safe_load((ROOT / "deploy/traefik-dynamic.yml").read_text())
        for router in dynamic["http"]["routers"].values():
            router["tls"] = {}
        (stage / "traefik.yml").write_text(yaml.safe_dump(config))
        (stage / "traefik-dynamic.yml").write_text(yaml.safe_dump(dynamic))
        container = subprocess.check_output([
            "docker", "run", "-d", "--network", "none", "-v",
            f"{stage}:/etc/littlespaces:ro", IMAGE,
            "--configFile=/etc/littlespaces/traefik.yml",
        ], text=True).strip()
        try:
            subprocess.run([
                "docker", "exec", "-d", container, "sh", "-c",
                "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n"
                "Connection: close\\r\\n\\r\\nok' | nc -l -p 5175 >> /tmp/requests; done",
            ], check=True)
            time.sleep(3)

            def request(path, host="apps.example.com"):
                return subprocess.run([
                    "docker", "exec", container, "wget", "-S", "-O", "-",
                    "--no-check-certificate", "--header", f"Host: {host}",
                    "--header", "X-Real-IP: 203.0.113.123", f"https://127.0.0.1{path}",
                ], text=True, capture_output=True, timeout=5)

            # Wait for the actual template's health-check interval.
            for _ in range(15):
                response = request("/health/live")
                if "200 OK" in response.stderr:
                    break
                time.sleep(1)
            else:
                raise AssertionError(response.stderr)
            assert "Strict-Transport-Security:" in response.stderr, response.stderr
            assert "404 Not Found" in request("/", "wrong.example.com").stderr
            replies = [request("/api/login").stderr for _ in range(4)]
            assert "429 Too Many Requests" in replies[-1], replies
            captured = subprocess.check_output(
                ["docker", "exec", container, "cat", "/tmp/requests"], text=True)
            assert "X-Real-Ip: 127.0.0.1" in captured, captured
            assert "203.0.113.123" not in captured, captured
            version = subprocess.check_output(
                ["docker", "exec", container, "traefik", "version"], text=True)
            print(version.splitlines()[0])
            print("Isolated Traefik routing, readiness, HSTS, rate limiting and forged "
                  "client-IP stripping passed; no ACME or public network used.")
        finally:
            subprocess.run(["docker", "rm", "-f", container], check=True,
                           stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
