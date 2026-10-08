# Third-party notices

LittleSpaces source is licensed under [MIT](LICENSE). Third-party components retain their own licenses.

| Component                  | Current source                                             | Notice                                                                         |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Preact                     | npm `preact` 10.29.8, used by the shell and applet runtime | [MIT license](licenses/PREACT.txt)                                             |
| HTM                        | npm `htm` 3.1.1, used by the applet runtime                | [Apache 2.0 license](licenses/HTM.txt)                                         |
| rquickjs                   | Cargo `rquickjs` 0.9.0                                     | [MIT license](licenses/RQUICKJS.txt)                                           |
| QuickJS                    | QuickJS source bundled by `rquickjs-sys` 0.9.0             | [MIT license and upstream copyrights](licenses/QUICKJS.txt)                    |
| Playwright seccomp profile | Adapted profile in `deploy/docker/seccomp.json`            | [Apache 2.0 license and upstream copyrights](deploy/docker/PLAYWRIGHT-LICENSE) |

The seccomp profile's upstream location and modifications are recorded in [the Rust guide](docs/rust-migration.md#docker-and-real-chatgpt-testing). License texts are retained from the installed locked packages; update the notices when changing their versions. `build:rust:web` copies these notices and the LittleSpaces license to `build-rust/web/licenses/` so they accompany bundled assets. Retain them when distributing the executable and web assets together.

This is a focused notice inventory, not a complete dependency audit. npm and Cargo lockfiles describe the remaining direct and transitive dependencies. The pinned Codex executable, browser binaries, container base images, and other dependencies require their applicable notices and distribution terms when packaged. Complete that inventory for the chosen release artifact before publishing binaries or images; the regression image is test tooling.
