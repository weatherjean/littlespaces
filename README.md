# LittleSpaces

Build and use personal apps through conversation, on your own VPS.

Describe an app, approve the proposal, and LittleSpaces builds, tests, and publishes it. Apps keep their data between updates and can run without model requests. One owner manages the workspace and ChatGPT connection; invited guests can use selected applets and their shared data.

## Install

You need a VPS with Docker Compose 2.24+, Python 3.9+, at least 4 GiB RAM, a domain pointing to it, and ports 80/443 open.

```sh
git clone https://github.com/weatherjean/littlespaces.git
cd littlespaces
git checkout v0.2.0
python3 scripts/configure-compose.py --mode traefik \
  --origin https://apps.example.com --acme-email you@example.com \
  --image-tag v0.2.0
docker compose pull
docker compose up -d --no-build --wait
docker compose logs app
```

Use matching app and verifier versions. For unreleased fixes, choose a commit whose **Production containers** workflow passed and use `sha-` followed by its full commit hash.

Open the private setup link printed in the app logs and create your owner account. In **Settings → ChatGPT**, choose **Continue with ChatGPT** and approve the one-time code. Model requests use your connected account's allowance.

See the [deployment guide](deploy/README.md) for updates, health checks, private Tailscale access, and backup/restore.

## Use it

- Build and update apps through chat. Generated backends and interfaces are tested before publication.
- Use app chat, images, schedules, notifications, and voice controls.
- [Invite friends](docs/guest-sharing.md) to selected applets. Their data is shared; participant names are labels, not private accounts inside an applet.
- Use **Versions & tests** to review releases and restore points. **Settings → Storage & recovery** provides manual cleanup.

## Data and limits

The Docker workspace volume holds your data, encryption key, and ChatGPT credentials. Container updates preserve it. **Do not run `docker compose down --volumes` on a real workspace.** App restore points are not independent backups and cannot undo actions taken by external services.

LittleSpaces is experimental. Container and browser tests cover the documented flows; they do not establish physical-device support, disaster recovery, or unrestricted workload capacity. Voice and push behavior depend on the browser and device. The offline page does not provide offline access to app data.

App interfaces run in sandboxed iframes and backend actions run in restricted workers. Published backends can use the workspace's integration secrets, so review what you share. See [SECURITY.md](SECURITY.md).

## Development and reference

- [Contributing and checks](CONTRIBUTING.md)
- [Release process](docs/releasing.md)
- [ChatGPT connection](docs/rhai/sign-in.md)
- [Applet SDK](docs/rhai/sdk.md) and [frontend conventions](docs/rhai/frontend.md)
- [Terminology](CONTEXT.md)
- [Historical implementation notes](docs/rhai/status.md)

Licensed under [MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
