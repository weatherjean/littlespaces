use super::*;
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use scrypt::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Scrypt,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
#[derive(Clone)]
pub struct OwnerAuth {
    store: Store,
    setup: Arc<zeroize::Zeroizing<String>>,
    gate: Arc<tokio::sync::Semaphore>,
    attempts: Arc<std::sync::Mutex<std::collections::BTreeMap<String, (u32, i64)>>>,
}
#[derive(Clone, serde::Serialize)]
pub struct Session {
    pub csrf: String,
}
pub(crate) fn token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
pub(crate) fn hash_token(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
impl OwnerAuth {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            setup: Arc::new(zeroize::Zeroizing::new(token())),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
            attempts: Default::default(),
        }
    }
    pub fn setup_token(&self) -> &str {
        &self.setup
    }
    pub fn configured(&self) -> Result<bool> {
        Ok(self
            .store
            .open()?
            .query_row("SELECT EXISTS(SELECT 1 FROM owner_auth)", [], |r| r.get(0))?)
    }
    pub async fn setup(&self, supplied: String, password: String) -> Result<()> {
        if !bool::from(supplied.as_bytes().ct_eq(self.setup.as_bytes())) {
            return Err(Error::Unauthorized);
        }
        self.set_password(password, false).await
    }
    pub async fn reset(&self, password: String) -> Result<()> {
        self.set_password(password, true).await?;
        self.attempts
            .lock()
            .map_err(|_| Error::Authentication)?
            .clear();
        Ok(())
    }
    async fn set_password(&self, password: String, reset: bool) -> Result<()> {
        if password.chars().count() < 15 || password.len() > 1024 {
            return Err(Error::Validation);
        }
        let permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let _permit=permit; let password=zeroize::Zeroizing::new(password);
            let salt=SaltString::generate(&mut rand::rngs::OsRng);
            let encoded=Scrypt.hash_password(password.as_bytes(),&salt).map_err(|_| Error::Authentication)?.to_string();
            let mut db=store.open()?; let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if !reset && tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_auth)",[],|r|r.get::<_,bool>(0))? { return Err(Error::Conflict); }
            tx.execute("INSERT INTO owner_auth(id,password_hash) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,failures=0,locked_until=0",[encoded])?;
            tx.execute("DELETE FROM owner_sessions",[])?; tx.commit()?; Ok(())
        }).await.map_err(|_|Error::Authentication)?
    }
    pub async fn login(&self, password: String) -> Result<(String, Session)> {
        self.login_from(password, "local".into()).await
    }
    pub async fn login_from(&self, password: String, source: String) -> Result<(String, Session)> {
        if password.len() > 1024 {
            return Err(Error::Unauthorized);
        }
        let permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        // Reserve before hashing. Per-source windows are bounded and cannot lock other sources out.
        {
            let mut attempts = self.attempts.lock().map_err(|_| Error::Authentication)?;
            attempts.retain(|_, (_, expires)| *expires > now());
            if !attempts.contains_key(&source) && attempts.len() >= 4096 {
                return Err(Error::Saturated);
            }
            let entry = attempts.entry(source.clone()).or_insert((0, now() + 300));
            if entry.0 >= 3 {
                return Err(Error::LoginThrottled);
            }
            entry.0 += 1;
        }
        let store = self.store.clone();
        let attempts = self.attempts.clone();
        tokio::task::spawn_blocking(move || {
            let _permit=permit; let password=zeroize::Zeroizing::new(password); let db=store.open()?;
            let encoded:String=db.query_row("SELECT password_hash FROM owner_auth WHERE id=1",[],|r|r.get(0)).optional()?.ok_or(Error::Unauthorized)?;
            let valid=PasswordHash::new(&encoded).ok().is_some_and(|hash|Scrypt.verify_password(password.as_bytes(),&hash).is_ok());
            if !valid { return Err(Error::Unauthorized); }
            attempts.lock().map_err(|_| Error::Authentication)?.remove(&source);
            db.execute("DELETE FROM owner_sessions WHERE expires_at<=?",[now()])?;
            db.execute("DELETE FROM owner_sessions WHERE id IN (SELECT id FROM owner_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 49)",[])?;
            let session=token(); let csrf=token(); db.execute("INSERT INTO owner_sessions VALUES(?,?,?)",params![hash_token(&session),now()+86400,csrf])?;
            Ok((session,Session {csrf}))
        }).await.map_err(|_|Error::Authentication)?
    }
    pub fn session(&self, session: &str) -> Result<Session> {
        self.store
            .open()?
            .query_row(
                "SELECT csrf FROM owner_sessions WHERE id=? AND expires_at>?",
                params![hash_token(session), now()],
                |r| Ok(Session { csrf: r.get(0)? }),
            )
            .optional()?
            .ok_or(Error::Unauthorized)
    }
    pub fn logout(&self, session: &str) -> Result<()> {
        self.store.open()?.execute(
            "DELETE FROM owner_sessions WHERE id=?",
            [hash_token(session)],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn setup_login_lockout_and_reset_revoke_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let owner = OwnerAuth::new(store);
        assert_eq!(
            owner
                .setup("wrong".into(), "long synthetic password".into())
                .await,
            Err(Error::Unauthorized)
        );
        owner
            .setup(owner.setup_token().into(), "long synthetic password".into())
            .await
            .unwrap();
        assert_eq!(
            owner
                .setup(
                    owner.setup_token().into(),
                    "another synthetic password".into()
                )
                .await,
            Err(Error::Conflict)
        );
        let (token, session) = owner.login("long synthetic password".into()).await.unwrap();
        assert_eq!(owner.session(&token).unwrap().csrf, session.csrf);
        for _ in 0..3 {
            assert!(matches!(
                owner.login("wrong password".into()).await,
                Err(Error::Unauthorized)
            ));
        }
        assert!(matches!(
            owner.login("long synthetic password".into()).await,
            Err(Error::LoginThrottled)
        ));
        assert!(owner
            .login_from("long synthetic password".into(), "other-source".into())
            .await
            .is_ok());
        owner
            .reset("replacement synthetic password".into())
            .await
            .unwrap();
        assert!(owner.session(&token).is_err());
        assert!(owner
            .login("replacement synthetic password".into())
            .await
            .is_ok());
    }
}
