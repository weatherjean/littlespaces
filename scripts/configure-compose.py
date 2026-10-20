#!/usr/bin/env python3
"""Create local deployment settings without printing or replacing credentials."""
import argparse
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["local", "traefik", "tailscale"], default="local")
    parser.add_argument("--origin", default="http://127.0.0.1:8080")
    parser.add_argument("--acme-email", default="")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--secrets-dir", type=Path, default=ROOT / "deploy/secrets")
    parser.add_argument("--image-tag", default="local")
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if (origin.path not in ("", "/") or origin.query or origin.fragment or origin.username
            or origin.password or not origin.hostname):
        parser.error("Use an origin only, without credentials, path, query, or fragment")
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", origin.hostname):
        parser.error("Use a DNS hostname or 127.0.0.1 without special characters")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", args.image_tag):
        parser.error("Use a version or sha-commit image tag")
    if args.mode == "local":
        if origin.scheme != "http" or origin.hostname != "127.0.0.1":
            parser.error("Local mode requires http://127.0.0.1:PORT")
    elif origin.scheme != "https" or origin.port not in (None, 443):
        parser.error("Remote modes require an HTTPS origin on port 443")
    if args.mode == "traefik" and not args.acme_email:
        parser.error("Traefik requires --acme-email for certificates")
    if args.mode == "tailscale" and not origin.hostname.endswith(".ts.net"):
        parser.error("Tailscale mode requires the device's full .ts.net HTTPS name")
    values = {
        "COMPOSE_FILE": f"compose.yaml:compose.{args.mode}.yaml",
        "LITTLESPACES_PUBLIC_URL": args.origin.rstrip("/"),
        "LITTLESPACES_HOST": origin.hostname,
        "LITTLESPACES_AUTHORITY": origin.netloc,
        "LITTLESPACES_PORT": str(origin.port or 8080) if args.mode == "local" else "8080",
        "LITTLESPACES_BROWSER_TOKEN_FILE": str(args.secrets_dir.resolve() / "browser_token"),
        "LITTLESPACES_APP_IMAGE": f"ghcr.io/weatherjean/appsappsapps:{args.image_tag}",
        "LITTLESPACES_VERIFIER_IMAGE": f"ghcr.io/weatherjean/appsappsapps-verifier:{args.image_tag}",
    }
    if args.mode == "traefik":
        values["ACME_EMAIL"] = args.acme_email
        values["VAPID_SUBJECT"] = f"mailto:{args.acme_email}"
    if args.mode == "tailscale":
        values["TAILSCALE_HOSTNAME"] = origin.hostname.split(".")[0]
        values["TAILSCALE_AUTHKEY_FILE"] = str(args.secrets_dir.resolve() / "tailscale_authkey")
    if any(any(c in value for c in "\r\n$#'\"") for value in values.values()):
        parser.error("Settings contain unsupported dotenv characters")
    # Refuse accidental overwrites, including symlinks, of deployment configuration.
    with args.env_file.open("x") as output:
        os.chmod(args.env_file, 0o600)
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    args.secrets_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.secrets_dir, 0o700)
    token = args.secrets_dir / "browser_token"
    if not token.exists():
        with token.open("x") as output:
            output.write(secrets.token_hex(32) + "\n")
        # Compose bind-mounted secrets retain source permissions. The containing
        # directory is owner-only; each non-root container can read its own mount.
        token.chmod(0o444)
    print(f"Created {args.env_file}. Run docker compose up -d --build --wait")
    if args.mode == "tailscale":
        print("Put a scoped Tailscale auth key in the configured private auth-key file first.")
        print("Make that file readable by the container; keep its parent directory mode 0700.")


if __name__ == "__main__":
    main()
