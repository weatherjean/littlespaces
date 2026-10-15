#[cfg(unix)]
#[test]
fn cli_refuses_workspace_before_installing_schema() {
    use little_spaces::core::workspace::WorkspaceLock;
    use std::process::Command;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/core/schema.sql"))
        .unwrap();
    let lock = WorkspaceLock::acquire(directory.path()).unwrap();
    for command in ["secrets", "serve", "owner-reset"] {
        let output = Command::new(env!("CARGO_BIN_EXE_little-spaces"))
            .arg(command)
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{command} bypassed lock");
        assert!(String::from_utf8_lossy(&output.stderr).contains("workspace is in use"));
    }
    let extensions: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='notifications'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(extensions, 0, "CLI changed schema before acquiring lock");
    drop(lock);
    assert!(Command::new(env!("CARGO_BIN_EXE_little-spaces"))
        .arg("secrets")
        .arg(directory.path())
        .output()
        .unwrap()
        .status
        .success());
}
