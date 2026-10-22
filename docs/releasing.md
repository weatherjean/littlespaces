# Releasing LittleSpaces

Docker Compose is the supported deployment. Native archives are development and diagnostic artifacts. Releases remain experimental; report tested behavior and remaining gaps plainly.

## Prepare

1. Update the version in `rust/Cargo.toml`, `rust/Cargo.lock`, and the runtime package files. Update installation examples and write release notes.
2. Run the relevant [contributor checks](../CONTRIBUTING.md#focused-checks), `python3 scripts/test-compose-config.py`, and `python3 scripts/test-compose.py --build`. The container test uses disposable volumes and synthetic data.
3. Commit to `main` and require green **Rust monolith** and **Production containers** workflows for that exact commit on AMD64 and ARM64. Check dependency audits as well as runtime tests.
4. Tag the tested commit `vX.Y.Z` and push the tag. Wait for its container workflow to publish matching app and verifier version tags before publishing the GitHub release.

Real ChatGPT tests consume account usage and require explicit authorization. Keep prompts, credentials, screenshots and workspaces out of commits and release assets. Ordinary CI uses synthetic providers. When testing model behavior, record the model, scenario and observed outcome separately from fixture results.

Release notes should cover user-visible changes, setup/update steps, compatibility and known limitations. Do not describe browser fixtures as real-account tests or a successful scenario as a guarantee for every generated app. Keep historical reviews as dated evidence, not current installation instructions.

## Images and deployment

CI publishes architecture images after each container smoke test, then combines them into `sha-<full-commit>` images. A version tag also produces `vX.Y.Z` images. App and verifier must use matching tags or digests. Confirm registry visibility and record the deployed image digests.

Follow the [deployment guide](../deploy/README.md) for normal updates: retain `.env`, secrets, project name and volumes; pull images and run `docker compose up -d --no-build --wait`. Check readiness, HTTPS, saved account state and existing app data. Updating does not require a special rollback backup. A downgrade requires compatible data; never open a newer workspace with an older binary.

Physical-device voice/push behavior, provider credential renewal and off-host recovery need separate testing. State which were actually checked.

## Native diagnostic packages

Generate notices for the actual target and toolchain, then package into a new directory:

```sh
python3 scripts/generate-notices.py build-rust/notices --openssl-notice /usr/share/doc/libssl-dev/copyright
python3 scripts/package-release.py build-rust/release
python3 scripts/production-smoke.py --binary build-rust/release/little-spaces
```

The OpenSSL path is for Debian/Ubuntu; on Homebrew macOS use `"$(brew --prefix openssl@3)/LICENSE.txt"`. Packaging rebuilds locked dependencies and the optimized executable for the local target. Do not edit the checkout while it runs. Use a fresh notice directory or pass an existing compatible inventory with `--notices`.

Inspect the public-file allowlist, recorded commit/dirty flag, `SHA256SUMS`, and third-party notices. Never include workspaces, credentials or private test output. `scripts/test-release.py` checks symlink, notice and checksum boundaries. Release packages must identify a clean immutable revision.
