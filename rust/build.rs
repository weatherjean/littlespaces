use std::{env, fs, path::PathBuf};
fn main() {
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
    source.push_str(&format!("pub const READY:bool={ready};\n"));
    fs::write(out.join("assets.rs"), source).unwrap();
}
