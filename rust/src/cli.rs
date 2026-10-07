use crate::{
    auth::Auth,
    store::{Result, Store},
};
use serde_json::json;
use std::io::{BufRead, Write};
fn input(prompt: &str, secret: bool) -> Result<String> {
    print!("{prompt}");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    struct Restore(Option<libc::termios>);
    #[cfg(unix)]
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(settings) = &self.0 {
                unsafe {
                    libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, settings);
                }
            }
        }
    }
    #[cfg(unix)]
    let _restore = unsafe {
        let mut settings = std::mem::zeroed();
        if secret && libc::tcgetattr(libc::STDIN_FILENO, &mut settings) == 0 {
            let original = settings;
            settings.c_lflag &= !libc::ECHO;
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &settings);
            Restore(Some(original))
        } else {
            Restore(None)
        }
    };
    let mut value = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut value)
        .map_err(|e| e.to_string())?;
    if secret {
        println!();
    }
    Ok(value.trim_end_matches(['\r', '\n']).into())
}
pub async fn owner(reset: bool) -> Result<()> {
    let directory = std::env::var("RUST_DATA_DIR")
        .or_else(|_| std::env::var("APP_DATA_DIR"))
        .unwrap_or(".data-rust".into());
    let store = Store::new(directory.into())?;
    let auth = Auth::new(&store)?;
    let email = input("Owner email: ", false)?;
    let password = input("Password (15–256 characters): ", true)?;
    let confirmation = input("Confirm password: ", true)?;
    let values = json!({"email":email,"password":password,"confirmation":confirmation,"token":auth.setup_token});
    if reset {
        auth.reset(&store, &values).await?;
    } else {
        auth.configure(&store, &values).await?;
    }
    println!(
        "Owner account {}. Existing app data is preserved.",
        if reset {
            "reset; all sessions revoked"
        } else {
            "created"
        }
    );
    Ok(())
}

pub fn import_workspace(source: &std::path::Path) -> Result<()> {
    let destination = std::path::PathBuf::from(
        std::env::var("RUST_DATA_DIR")
            .or_else(|_| std::env::var("APP_DATA_DIR"))
            .unwrap_or(".data-rust".into()),
    );
    import_into(source, &destination)
}
pub fn import_into(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
    let destination = destination.to_path_buf();
    let source = std::fs::canonicalize(source).map_err(|_| "Source workspace not found")?;
    if !source.join("workspace.sqlite").is_file() || !source.join("owner.sqlite").is_file() {
        return Err("Source must contain workspace.sqlite and owner.sqlite".into());
    }
    if destination.join("workspace.sqlite").exists() || destination.join("owner.sqlite").exists() {
        return Err("Destination already contains a workspace. Choose a new RUST_DATA_DIR; import never overwrites data.".into());
    }
    if destination.exists()
        && std::fs::read_dir(&destination)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("Destination must be empty. Import never overwrites files.".into());
    }
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or("Choose a destination directory")?,
    );
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err("Source and destination must be separate directories".into());
    }
    let staging = parent.join(format!(".data-rust-import-{}", crate::random_id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(staging.clone());
    fn copy(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
        if source.is_dir() {
            std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
            for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name();
                let name_string = name.to_string_lossy();
                if name_string.ends_with("-wal")
                    || name_string.ends_with("-shm")
                    || name_string.ends_with("-journal")
                {
                    continue;
                }
                if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                    continue;
                }
                copy(&entry.path(), &destination.join(name))?;
            }
            return Ok(());
        }
        if source.extension().and_then(|e| e.to_str()) == Some("sqlite") {
            let source = rusqlite::Connection::open_with_flags(
                source,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| e.to_string())?;
            let mut destination_db =
                rusqlite::Connection::open(destination).map_err(|e| e.to_string())?;
            let backup = rusqlite::backup::Backup::new(&source, &mut destination_db)
                .map_err(|e| e.to_string())?;
            backup
                .run_to_completion(100, std::time::Duration::from_millis(10), None)
                .map_err(|e| e.to_string())?;
        } else {
            std::fs::copy(source, destination).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    for name in [
        "workspace.sqlite",
        "owner.sqlite",
        "sessions.sqlite",
        "secrets.key",
        "credentials.json",
        "applets",
        "codex",
    ] {
        let path = source.join(name);
        if path.exists() {
            copy(&path, &staging.join(name))?;
        }
    }
    Store::new(staging.clone())?;
    for path in std::fs::read_dir(&staging).map_err(|e| e.to_string())? {
        let path = path.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) == Some("sqlite") {
            let db = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| e.to_string())?;
            let integrity: String = db
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if integrity != "ok" {
                return Err("Imported database failed its integrity check".into());
            }
        }
    }
    std::fs::rename(&staging, &destination).map_err(|e| e.to_string())?;
    println!("Imported workspace into {}. Source data is unchanged. Existing compiled Svelte applets remain supported; future updates use Preact.",destination.display());
    Ok(())
}
