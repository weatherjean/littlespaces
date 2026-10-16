use std::{env, fs, path::PathBuf};
fn main() {
    if env::var("PROFILE").as_deref() == Ok("release")
        && env::var_os("CARGO_FEATURE_DEVELOPMENT_FIXTURES").is_some()
    {
        panic!("Release builds must not enable development-fixtures");
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let mut source = String::new();
    let mut ready = true;
    for (name, file) in [
        ("SHELL_JS", "shell.js"),
        ("APPLET_JS", "applet.js"),
        ("STYLE_CSS", "style.css"),
    ] {
        let path = PathBuf::from("../build-rust/core").join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let data = fs::read(&path).unwrap_or_else(|_| {
            ready = false;
            Vec::new()
        });
        fs::write(out.join(file), data).unwrap();
        source.push_str(&format!(
            "pub const {name}: &[u8]=include_bytes!(concat!(env!(\"OUT_DIR\"),\"/{file}\"));\n"
        ));
    }
    source.push_str(
        "pub fn public_asset(path: &str) -> Option<(&'static [u8], &'static str)> { match path {\n",
    );
    for (file, kind) in [
        ("manifest.webmanifest", "application/manifest+json"),
        ("offline.html", "text/html; charset=utf-8"),
        ("favicon.ico", "image/x-icon"),
        ("favicon-16.png", "image/png"),
        ("favicon-32.png", "image/png"),
        ("icon.svg", "image/svg+xml"),
        ("apple-touch-icon.png", "image/png"),
        ("icon-180.png", "image/png"),
        ("icon-192.png", "image/png"),
        ("icon-512.png", "image/png"),
        ("icon-maskable-512.png", "image/png"),
        ("service-worker.js", "text/javascript"),
    ] {
        let path = if file == "service-worker.js" {
            PathBuf::from("../web/core").join(file)
        } else {
            PathBuf::from("../static").join(file)
        };
        println!("cargo:rerun-if-changed={}", path.display());
        fs::copy(path, out.join(file)).expect("required public asset");
        source.push_str(&format!("\"/{file}\" => Some((include_bytes!(concat!(env!(\"OUT_DIR\"),\"/{file}\")),\"{kind}\")),\n"));
    }
    source.push_str("_ => None }}\n");
    if env::var("PROFILE").as_deref() == Ok("release") && !ready {
        panic!("Release builds require frontend assets: run npm ci --prefix web && npm run build --prefix web first");
    }
    source.push_str(&format!("pub const READY:bool={ready};\n"));
    fs::write(out.join("assets.rs"), source).unwrap();
}
