use little_spaces::core::{http::MockHttp, secrets::Secrets, store::ExternalDecision, *};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

mod worker_allocator;
#[global_allocator]
static ALLOCATOR: worker_allocator::Budget = worker_allocator::Budget;
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--action-worker") {
        worker_allocator::ENABLED.store(true, std::sync::atomic::Ordering::Relaxed);
        if little_spaces::core::worker::run().is_err() {
            std::process::exit(1);
        }
        return;
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(host_main());
}
async fn host_main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let command=args.next().ok_or("Usage: little-spaces <init|serve|backup|storage|owner-reset|create|test|publish|run|dry-run|secrets|secret-put|secret-delete|evidence|effect-resolve> <workspace-directory> ...")?;
    let directory = args.next().ok_or("Provide a workspace directory")?;
    let directory = Path::new(&directory);
    if command == "init" {
        // Fresh directories avoid accidentally reusing development databases or encryption keys.
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
    } else if !directory.join("workspace.sqlite").exists() {
        return Err("Initialize a fresh workspace first".into());
    }
    if command == "serve" {
        let port = args
            .next()
            .map(|s| s.parse::<u16>())
            .transpose()?
            .unwrap_or(5175);
        return little_spaces::core::server::serve(directory.to_path_buf(), port).await;
    }
    let _workspace_lock = workspace::WorkspaceLock::acquire(directory)?;
    let store = Store::create(&directory.join("workspace.sqlite"))?;
    let secrets = Secrets::open(store.clone(), &directory.join("secrets.key"))?;
    let runtime = Runtime::new(store.clone(), secrets.clone(), 4)?;
    if command == "owner-reset" {
        let mut password = zeroize::Zeroizing::new(String::new());
        std::io::stdin().take(1025).read_to_string(&mut password)?;
        little_spaces::core::owner::OwnerAuth::new(store)
            .reset(password.trim_end_matches(['\r', '\n']).into())
            .await?;
        println!("Owner password reset; sessions revoked");
        return Ok(());
    }
    let mut next = || args.next().ok_or("Missing command argument");
    let result: Value = match command.as_str() {
        "init" => json!({"initialized":true}),
        "backup" => {
            let destination = next()?;
            maintenance::backup(
                &store,
                Path::new(&destination),
                &directory.join("secrets.key"),
            )?;
            json!({"backedUp":true})
        }
        "storage" => maintenance::status(&store, &maintenance::Retention::default())?,
        "create" => {
            let title = next()?;
            let path = next()?;
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(256 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 256 * 1024 {
                return Err(Error::Limit.into());
            }
            let code: AppCode = serde_json::from_slice(&bytes).map_err(|_| Error::Validation)?;
            code.validate()?;
            let app = store.create_app(&title)?;
            let draft = store.create_draft(&app, code)?;
            let revision = store.freeze_draft(&draft.id, 1)?;
            json!({"app":app,"draft":draft.id,"revision":revision.id})
        }
        "test" => {
            let app = AppId(next()?);
            let revision = RevisionId(next()?);
            runtime
                .test_revision(app, revision, MockHttp::default(), Cancellation::default())
                .await?;
            json!({"backendTestsPassed":true})
        }
        "publish" => {
            let app = AppId(next()?);
            let revision = RevisionId(next()?);
            let before = store.snapshot(&app)?;
            store.publish(&app, &revision, before.revision.as_ref())?;
            json!({"published":revision})
        }
        "run" | "dry-run" => {
            let app = AppId(next()?);
            let revision = RevisionId(next()?);
            let action = next()?;
            let input: Value = serde_json::from_str(&next()?).map_err(|_| Error::Validation)?;
            let id = InvocationId::new();
            let request = Invocation {
                id: id.clone(),
                app: app.clone(),
                revision,
                action,
                input,
                mode: if command == "run" {
                    ExecutionMode::Commit
                } else {
                    ExecutionMode::DryRun
                },
            };
            match runtime
                .invoke(request, MockHttp::default(), Cancellation::default())
                .await
            {
                Ok(result) => {
                    json!({"invocation":id,"result":result,"externalEffects":store.external_evidence(&app,&id)?})
                }
                Err(error) => {
                    eprintln!(
                        "{}",
                        json!({"invocation":id,"error":error,"externalEffects":store.external_evidence(&app,&id)?})
                    );
                    return Err(error.into());
                }
            }
        }
        "models" => {
            let auth = little_spaces::core::chatgpt::ChatGpt::new(store.clone(), secrets.clone())?;
            let models = auth.models().await?;
            json!({"availableModels":models.as_array().map_or(0,Vec::len)})
        }
        "secrets" => serde_json::to_value(secrets.list()?)?,
        "secret-put" => {
            let name = next()?;
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            std::io::stdin().take(16001).read_to_end(&mut bytes)?;
            let value = zeroize::Zeroizing::new(
                String::from_utf8(bytes.to_vec()).map_err(|_| Error::Validation)?,
            );
            secrets.put(&name, &value)?;
            json!({"saved":name})
        }
        "secret-delete" => {
            let name = next()?;
            secrets.delete(&name)?;
            json!({"deleted":name})
        }
        "effect-resolve" => {
            let app = AppId(next()?);
            let operation = next()?;
            let decision = match next()?.as_str() {
                "applied" => ExternalDecision::Applied,
                "not_applied" => ExternalDecision::NotApplied,
                "accept_unknown" => ExternalDecision::AcceptUnknown,
                _ => return Err("Choose applied, not_applied or accept_unknown".into()),
            };
            store.resolve_external(&app, &operation, decision)?;
            json!({"acknowledged":operation})
        }
        "evidence" => {
            serde_json::to_value(store.external_evidence(&AppId(next()?), &InvocationId(next()?))?)?
        }
        _ => return Err("Unknown command".into()),
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
