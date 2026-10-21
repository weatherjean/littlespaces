use super::*;
use rusqlite::params;

pub(super) async fn authorize(
    s: &Server,
    h: &HeaderMap,
    app: &str,
    revision: Option<&str>,
) -> Result<super::super::owner::Session> {
    let session = account_session(s, h).await?;
    if let Some(guest) = session.guest.clone() {
        let app = app.to_owned();
        let revision = revision.map(str::to_owned);
        s.runtime.store.blocking(move |store| {
            let allowed:bool=store.open()?.query_row("SELECT EXISTS(SELECT 1 FROM guest_apps g JOIN apps a ON a.id=g.app WHERE g.guest=?1 AND a.id=?2 AND a.published_revision IS NOT NULL AND (?3 IS NULL OR a.published_revision=?3) AND NOT EXISTS(SELECT 1 FROM archived_apps x WHERE x.app=a.id))",params![guest,app,revision],|r|r.get(0))?;
            if allowed {Ok(())} else {Err(Error::Unauthorized)}
        }).await?;
    }
    Ok(session)
}
pub(super) async fn register_email(
    State(s): State<Arc<Server>>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let email = text(&v, "email")?;
    let owner = s.owner.clone();
    s.runtime
        .store
        .blocking(move |_| owner.register_email(&email))
        .await?;
    Ok(Json(json!({"saved":true})))
}
pub(super) async fn password(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Api<Value> {
    s.owner
        .change_password(cookie(&h), text(&v, "current")?, text(&v, "password")?)
        .await?;
    Ok(Json(json!({"saved":true})))
}
pub(super) async fn guests(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(|store| {
                let db = store.open()?;
                let mut q = db.prepare("SELECT id,email FROM guests ORDER BY email")?;
                let guests = q
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let mut result = Vec::new();
                for (id, email) in guests {
                    let mut q = db.prepare("SELECT app FROM guest_apps WHERE guest=?")?;
                    let apps = q
                        .query_map([&id], |r| r.get::<_, String>(0))?
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    result.push(json!({"id":id,"email":email,"apps":apps}));
                }
                Ok(json!(result))
            })
            .await?,
    ))
}
fn app_ids(v: &Value) -> Result<Vec<String>> {
    serde_json::from_value(v["apps"].clone()).map_err(|_| Error::Validation)
}
pub(super) async fn create_guest(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    Ok(Json(
        s.owner
            .create_guest(text(&v, "email")?, app_ids(&v)?)
            .await?,
    ))
}
pub(super) async fn update_guest(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let apps = app_ids(&v)?;
    s.runtime
        .store
        .blocking(move |store| {
            let mut db = store.open()?;
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            super::super::owner::replace_guest_apps(&tx, &id, &apps)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({"saved":true})))
}
pub(super) async fn delete_guest(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
) -> Api<Value> {
    s.runtime
        .store
        .blocking(move |store| {
            store
                .open()?
                .execute("DELETE FROM guests WHERE id=?", [id])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({"deleted":true})))
}
pub(super) async fn apps(State(s): State<Arc<Server>>, h: HeaderMap) -> Api<Value> {
    let guest = account_session(&s, &h)
        .await?
        .guest
        .ok_or(Error::Unauthorized)?;
    Ok(Json(s.runtime.store.blocking(move |store|{
        let db=store.open()?; let mut q=db.prepare("SELECT a.id,a.title,a.published_revision,(SELECT emoji FROM app_identity i WHERE i.app=a.id) FROM apps a JOIN guest_apps g ON g.app=a.id WHERE g.guest=? AND a.published_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archived_apps x WHERE x.app=a.id) ORDER BY a.title")?;
        let rows=q.query_map([guest],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"revision":r.get::<_,String>(2)?,"emoji":r.get::<_,Option<String>>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows))
    }).await?))
}
pub(super) async fn detail(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    h: HeaderMap,
) -> Api<Value> {
    authorize(&s, &h, &id, None).await?;
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| {
                let revision = store.snapshot(&AppId(id.clone()))?.revision;
                Ok(json!({"app":id,"revision":revision}))
            })
            .await?,
    ))
}
pub(super) async fn preview(
    State(s): State<Arc<Server>>,
    Path((app, revision)): Path<(String, String)>,
    h: HeaderMap,
) -> std::result::Result<Response, ApiError> {
    authorize(&s, &h, &app, Some(&revision)).await?;
    super::preview(State(s), Path((app, revision))).await
}
