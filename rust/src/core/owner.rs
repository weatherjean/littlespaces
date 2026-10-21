use super::*;
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use scrypt::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Scrypt,
};
use serde_json::Value;
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
    pub guest: Option<String>,
    pub email: Option<String>,
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
        self.login_account(None, password, source).await
    }
    pub async fn login_account(
        &self,
        email: Option<String>,
        password: String,
        source: String,
    ) -> Result<(String, Session)> {
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
            let owner_email:Option<String> = db.query_row("SELECT email FROM owner_profile WHERE id=1",[],|r|r.get(0)).optional()?;
            let email = email.map(|e| e.trim().to_lowercase());
            let guest: Option<String> = if email.is_some() && email != owner_email {
                db.query_row("SELECT id FROM guests WHERE email=?",[email.as_deref()],|r|r.get(0)).optional()?
            } else { None };
            if email.is_some() && email != owner_email && guest.is_none() { return Err(Error::Unauthorized); }
            let encoded:String= if let Some(id) = &guest {
                db.query_row("SELECT password_hash FROM guests WHERE id=?",[id],|r|r.get(0))?
            } else { db.query_row("SELECT password_hash FROM owner_auth WHERE id=1",[],|r|r.get(0)).optional()?.ok_or(Error::Unauthorized)? };
            // Missing email is supported only for legacy owners until they register one.
            if email.is_none() && owner_email.is_some() { return Err(Error::Unauthorized); }
            let valid=PasswordHash::new(&encoded).ok().is_some_and(|hash|Scrypt.verify_password(password.as_bytes(),&hash).is_ok());
            if !valid { return Err(Error::Unauthorized); }
            attempts.lock().map_err(|_| Error::Authentication)?.remove(&source);
            let session=token(); let csrf=token();
            if let Some(id) = &guest {
                db.execute("DELETE FROM guest_sessions WHERE expires_at<=?",[now()])?;
                db.execute("DELETE FROM guest_sessions WHERE id IN (SELECT id FROM guest_sessions WHERE guest=? ORDER BY expires_at DESC LIMIT -1 OFFSET 49)",[id])?;
                db.execute("INSERT INTO guest_sessions VALUES(?,?,?,?)",params![hash_token(&session),id,now()+86400,csrf])?;
            } else {
            db.execute("DELETE FROM owner_sessions WHERE expires_at<=?",[now()])?;
            db.execute("DELETE FROM owner_sessions WHERE id IN (SELECT id FROM owner_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 49)",[])?;
db.execute("INSERT INTO owner_sessions VALUES(?,?,?)",params![hash_token(&session),now()+86400,csrf])?; }
            Ok((session,Session {csrf,guest,email:email.or(owner_email)}))
        }).await.map_err(|_|Error::Authentication)?
    }
    pub fn session(&self, session: &str) -> Result<Session> {
        self.store
            .open()?
            .query_row(
                "SELECT csrf,(SELECT email FROM owner_profile WHERE id=1) FROM owner_sessions WHERE id=? AND expires_at>?",
                params![hash_token(session), now()],
                |r| Ok(Session { csrf: r.get(0)?, guest: None, email: r.get(1)? }),
            )
            .optional()?
            .ok_or(Error::Unauthorized)
    }
    pub fn account_session(&self, session: &str) -> Result<Session> {
        if let Ok(owner) = self.session(session) {
            return Ok(owner);
        }
        self.store.open()?.query_row("SELECT s.csrf,g.id,g.email FROM guest_sessions s JOIN guests g ON g.id=s.guest WHERE s.id=? AND s.expires_at>?",params![hash_token(session),now()],|r|Ok(Session {csrf:r.get(0)?,guest:Some(r.get(1)?),email:Some(r.get(2)?)})).optional()?.ok_or(Error::Unauthorized)
    }
    pub fn logout(&self, session: &str) -> Result<()> {
        self.store.open()?.execute(
            "DELETE FROM guest_sessions WHERE id=?",
            [hash_token(session)],
        )?;
        self.store.open()?.execute(
            "DELETE FROM owner_sessions WHERE id=?",
            [hash_token(session)],
        )?;
        Ok(())
    }
}

pub fn normalize_email(email: &str) -> Result<String> {
    let email = email.trim().to_lowercase();
    if email.len() > 254
        || email.chars().any(char::is_whitespace)
        || email.split('@').count() != 2
        || email.starts_with('@')
        || !email
            .split('@')
            .nth(1)
            .is_some_and(|d| d.contains('.') && !d.ends_with('.'))
    {
        return Err(Error::Validation);
    }
    Ok(email)
}
impl OwnerAuth {
    pub fn register_email(&self, email: &str) -> Result<()> {
        let email = normalize_email(email)?;
        let mut db = self.store.open()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM guests WHERE email=?)",
            [&email],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::Conflict);
        }
        tx.execute("INSERT INTO owner_profile VALUES(1,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email",[email])?;
        tx.commit()?;
        Ok(())
    }
    pub async fn create_guest(&self, email: String, apps: Vec<String>) -> Result<Value> {
        let email = normalize_email(&email)?;
        let permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let _permit=permit;
            let password=token();
            let encoded=Scrypt.hash_password(password.as_bytes(), &SaltString::generate(&mut rand::rngs::OsRng)).map_err(|_|Error::Authentication)?.to_string();
            let id=token();
            let mut db=store.open()?;
            let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_profile WHERE email=?1 UNION ALL SELECT 1 FROM guests WHERE email=?1)",[&email],|r|r.get::<_,bool>(0))? { return Err(Error::Conflict); }
            tx.execute("INSERT INTO guests VALUES(?,?,?)",params![id,email,encoded])?;
            for app in apps { tx.execute("INSERT OR IGNORE INTO guest_apps VALUES(?,?)",params![id,app])?; }
            tx.commit()?;
            Ok(serde_json::json!({"id":id,"email":email,"password":password}))
        }).await.map_err(|_|Error::Authentication)?
    }
    pub async fn change_password(
        &self,
        session_token: String,
        current: String,
        password: String,
    ) -> Result<()> {
        if password.chars().count() < 15 || password.len() > 1024 || current.len() > 1024 {
            return Err(Error::Validation);
        }
        let permit = self
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let auth = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let session = auth.account_session(&session_token)?;
            let current = zeroize::Zeroizing::new(current);
            let password = zeroize::Zeroizing::new(password);
            let mut db = auth.store.open()?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let encoded: String = if let Some(id) = &session.guest {
                tx.query_row("SELECT password_hash FROM guests WHERE id=?", [id], |r| {
                    r.get(0)
                })?
            } else {
                tx.query_row("SELECT password_hash FROM owner_auth WHERE id=1", [], |r| {
                    r.get(0)
                })?
            };
            if PasswordHash::new(&encoded)
                .ok()
                .is_none_or(|h| Scrypt.verify_password(current.as_bytes(), &h).is_err())
            {
                return Err(Error::Unauthorized);
            }
            let encoded = Scrypt
                .hash_password(
                    password.as_bytes(),
                    &SaltString::generate(&mut rand::rngs::OsRng),
                )
                .map_err(|_| Error::Authentication)?
                .to_string();
            if let Some(id) = session.guest {
                tx.execute(
                    "UPDATE guests SET password_hash=? WHERE id=?",
                    params![encoded, id],
                )?;
                tx.execute("DELETE FROM guest_sessions WHERE guest=?", [id])?;
            } else {
                tx.execute(
                    "UPDATE owner_auth SET password_hash=? WHERE id=1",
                    [encoded],
                )?;
                tx.execute("DELETE FROM owner_sessions", [])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|_| Error::Authentication)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn email_accounts_keep_owner_and_guest_sessions_separate() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let owner = OwnerAuth::new(store.clone());
        owner
            .setup(
                owner.setup_token().into(),
                "synthetic owner password".into(),
            )
            .await
            .unwrap();
        let (legacy, _) = owner
            .login("synthetic owner password".into())
            .await
            .unwrap();
        owner.register_email(" OWNER@example.test ").unwrap();
        assert_eq!(
            owner.session(&legacy).unwrap().email.as_deref(),
            Some("owner@example.test")
        );
        assert!(owner
            .login("synthetic owner password".into())
            .await
            .is_err());
        let (owner_token, _) = owner
            .login_account(
                Some("OWNER@example.test".into()),
                "synthetic owner password".into(),
                "owner".into(),
            )
            .await
            .unwrap();
        assert!(owner
            .create_guest("owner@example.test".into(), vec![])
            .await
            .is_err());
        let app = store.create_app("Shared").unwrap();
        let guest = owner
            .create_guest("FRIEND@example.test".into(), vec![app.0])
            .await
            .unwrap();
        let (guest_token, session) = owner
            .login_account(
                Some("friend@example.test".into()),
                guest["password"].as_str().unwrap().into(),
                "friend".into(),
            )
            .await
            .unwrap();
        assert_eq!(session.guest.as_deref(), guest["id"].as_str());
        assert!(owner.session(&guest_token).is_err());
        assert!(owner.account_session(&guest_token).is_ok());
        owner
            .change_password(
                guest_token.clone(),
                guest["password"].as_str().unwrap().into(),
                "replacement guest password".into(),
            )
            .await
            .unwrap();
        assert!(owner.account_session(&guest_token).is_err());
        assert!(owner.session(&owner_token).is_ok());
        let (guest_token, _) = owner
            .login_account(
                Some("friend@example.test".into()),
                "replacement guest password".into(),
                "friend".into(),
            )
            .await
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "DELETE FROM guests WHERE id=?",
                [guest["id"].as_str().unwrap()],
            )
            .unwrap();
        assert!(owner.account_session(&guest_token).is_err());
        assert!(owner.session(&owner_token).is_ok());
    }
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
