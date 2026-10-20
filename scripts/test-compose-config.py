#!/usr/bin/env python3
"""Verify exposure, isolation and persistence contracts of every Compose mode."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("COMPOSE_", "LITTLESPACES_", "TAILSCALE_", "ACME_"))}
    for mode in ["local", "traefik", "tailscale"]:
        domain = "127.0.0.1" if mode == "local" else (
            "apps.example.test" if mode == "traefik" else "apps.example.ts.net")
        env.update(LITTLESPACES_PUBLIC_URL=f"http://{domain}:8080" if mode == "local" else f"https://{domain}",
                   LITTLESPACES_HOST=domain,
                   LITTLESPACES_AUTHORITY=f"{domain}:8080" if mode == "local" else domain,
                   ACME_EMAIL="synthetic@example.test")
        config = json.loads(subprocess.check_output([
            "docker", "compose", "--env-file", "/dev/null", "-f", str(ROOT / "compose.yaml"),
            "-f", str(ROOT / f"compose.{mode}.yaml"), "config", "--format", "json"
        ], cwd=ROOT, env=env, text=True))
        services = config["services"]
        for name in ["app", "verifier"]:
            service = services[name]
            assert service["network_mode"] == "service:gateway"
            assert not service.get("ports") and not service.get("privileged")
            assert service["read_only"] and service["mem_limit"] and service["pids_limit"]
            assert "ALL" in service["cap_drop"]
        assert services["verifier"]["environment"]["LITTLESPACES_BROWSER_SANDBOX"] == "1"
        assert "workspace" not in [m.get("source") for m in services["verifier"]["volumes"]]
        assert "workspace" in [m.get("source") for m in services["app"]["volumes"]]
        ports = services["gateway"].get("ports", [])
        if mode == "local":
            assert len(ports) == 2 and all(p["host_ip"] == "127.0.0.1" for p in ports)
        elif mode == "tailscale":
            assert len(ports) == 1 and ports[0]["host_ip"] == "127.0.0.1"
            assert ports[0]["target"] == 1455
            tail = services["tailscale"]
            assert tail["environment"]["TS_USERSPACE"] == "true"
            assert not tail.get("privileged") and not tail.get("devices") and not tail.get("cap_add")
            assert "workspace" not in [m.get("source") for m in tail["volumes"]]
        else:
            assert {p["target"] for p in ports} == {80, 443, 1455}
            assert next(p for p in ports if p["target"] == 1455)["host_ip"] == "127.0.0.1"
        for service in services.values():
            assert not any("docker.sock" in m.get("target", "") for m in service.get("volumes", []))
    serve = json.loads((ROOT / "deploy/container/tailscale-serve.json").read_text())
    assert serve["AllowFunnel"] == {}
    print("Local, public Traefik and private Tailscale Compose contracts passed.")


if __name__ == "__main__":
    main()
