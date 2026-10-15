//! Process-wide ownership, acquired before opening or upgrading workspace state.
use std::{fs::File, path::Path};

pub struct WorkspaceLock {
    _file: File,
}
impl WorkspaceLock {
    pub fn acquire(directory: &Path) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(directory.join("server.lock"))?;
            // Keep the file open for the whole command. Never unlink a lock file:
            // another process could otherwise lock a different inode at this path.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "This workspace is in use by another LittleSpaces command or server",
                ));
            }
            Ok(Self { _file: file })
        }
        #[cfg(not(unix))]
        {
            let _ = directory;
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "Workspace locking requires a supported Unix host",
            ))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn ownership_is_exclusive_and_released_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let first = WorkspaceLock::acquire(directory.path()).unwrap();
        assert!(WorkspaceLock::acquire(directory.path()).is_err());
        drop(first);
        assert!(WorkspaceLock::acquire(directory.path()).is_ok());
    }
}
