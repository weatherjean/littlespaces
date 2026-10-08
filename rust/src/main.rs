use little_spaces::core::Store;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("init") {
        return Err("Usage: little-spaces init <new-workspace.sqlite>".into());
    }
    let path = args.next().ok_or("Provide a fresh database path")?;
    Store::create(std::path::Path::new(&path))?;
    println!("Workspace initialized");
    Ok(())
}
