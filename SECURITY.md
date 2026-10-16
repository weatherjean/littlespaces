# Security policy

LittleSpaces is an experimental, self-hosted, single-user application. There is no production-qualified release or guaranteed security response time. Fixes target the current single-user Rust implementation; older experimental runtimes are not maintained.

## Reporting a vulnerability

Do not put vulnerability details, credentials, private screenshots, or workspace files in a public issue or pull request.

Use the repository's **Security → Report a vulnerability** option if private reporting is available. If that option is absent, open an issue asking the maintainer to arrange a private reporting channel, without describing the vulnerability or including a reproduction. This repository does not currently publish a dedicated security email address.

In a private report, include the affected commit, OS, reproduction using synthetic data, expected security boundary, and observed impact. Do not send real passwords, tokens, `secrets.key`, `auth.json`, `testing.key`, owner-setup links, or a real workspace database. A minimal synthetic example is preferable to a full diagnostic archive.

## Trust model

- One owner controls the workspace and its connected ChatGPT account. This is not a public app-hosting or multi-tenant service.
- Generated interfaces run in sandboxed iframes. Restricted Rhai actions run in disposable worker processes; the host owns authentication, storage, and external requests.
- Every published backend can use every integration secret configured in that workspace. Secrets are host-managed, but this is not per-app authorization. Review generated behavior before giving it access to sensitive integrations.
- Model requests send relevant conversation and app context to the connected service. Local storage does not mean all processing stays offline.
- External calls may have effects that local rollback cannot undo. Interrupted or uncertain effects require owner review; do not blindly replay them.
- Linux and macOS have different resource-containment guarantees. See [execution details](CONTRIBUTING.md#durability-execution-isolation-and-maintenance) and the [deployment guide](deploy/README.md). Restricted execution is not a claim of a general native-code sandbox.

## Operating safely

Keep the default loopback listener private. Remote access needs the documented TLS reverse proxy and explicit trusted-origin configuration. Do not expose the browser verifier or use development-fixture builds as production artifacts.

Keep workspace directories and backups private. The database and encryption key are a pair; backups may contain usable credentials. Stop the host before administrative backup/restore operations and test restoration with the matching binary. Never remove lock files, force schema versions, or delete data to bypass a startup error.

Track dependency advisories and review the [release checklist](docs/releasing.md). Historical test results are evidence for their recorded revision and environment, not a guarantee about a future deployment.
