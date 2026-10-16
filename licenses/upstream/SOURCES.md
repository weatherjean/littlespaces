# Supplemental upstream license sources

These crates omit license files from their published crate archives. The following texts were retrieved from the exact Git commits recorded in each archive's `.cargo_vcs_info.json`, not from a moving branch:

| File | Packages | Upstream source |
| --- | --- | --- |
| JSONSCHEMA-MIT.txt | jsonschema 0.26.2, referencing 0.26.2 | https://github.com/Stranger6667/jsonschema/blob/b8eef873017a4ce84eb3281965ce7a2791f95e51/LICENSE |
| SIMD-MIT.txt | uuid-simd 0.8.0, vsimd 0.8.0 | https://github.com/Nugine/simd/blob/d74c030d9dc4f3cae02146d1f497ff62726ef09a/LICENSE |
| RHAI-CODEGEN-MIT.txt | rhai_codegen 3.2.0 | https://github.com/rhaiscript/rhai/blob/b247dd730de3f2c97fa1e46f138a17f9d844de67/LICENSE-MIT.txt |

The generator uses these only for the listed package versions. Dependency updates require revisiting missing notice files. Rhai codegen offers MIT OR Apache-2.0; this supplement retains its MIT option.
