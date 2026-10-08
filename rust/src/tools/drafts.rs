//! Approved draft authoring, isolated tests, and publication orchestration.
use super::Tools;
use crate::{
    automation, backend,
    store::{text, Result},
};
use serde_json::{json, Value};

impl Tools {
    pub(super) async fn draft(&mut self, name: &str, input: Value) -> Result<Value> {
        if !self.skill_loaded {
            return Err("Load the build skill before changing code".into());
        }
        let store = &self.app.store;
        let approved = self.approved.as_ref().ok_or("Approve a build plan first")?;
        let live_plan = store.json_row("build_plans", &self.chat)?;
        if live_plan["id"] != approved["id"] || live_plan["status"] != json!("running") {
            return Err("Build approval is no longer active".into());
        }
        let applet = store.applet_id_optional(&self.space)?;
        let mut draft = match store.json_row_optional("build_drafts", &self.chat)? {
            Some(draft) => draft,
            None => {
                let content = match applet.as_deref() {
                    Some(id) => store.revision(id, None)?,
                    None => {
                        json!({"title":approved["title"],"description":"","source":"","backend":"","chatInstructions":""})
                    }
                };
                json!({
                    "target": applet.clone().unwrap_or_else(crate::random_uuid),
                    "baseVersion": content["version"].as_i64().unwrap_or(0),
                    "revision": 0,
                    "content": content,
                })
            }
        };
        if name == "read_draft" {
            return Ok(draft);
        }
        if draft["revision"] != input["revision"] {
            return Err("Draft changed. Read and use its current revision".into());
        }
        match name {
            "write_draft" | "edit_draft" => {
                if name == "write_draft" {
                    for field in [
                        "title",
                        "description",
                        "source",
                        "backend",
                        "chatInstructions",
                    ] {
                        if !input[field].is_null() {
                            if !input[field].is_string() {
                                return Err(format!("{field} must be a string"));
                            }
                            draft["content"][field] = input[field].clone();
                        }
                    }
                } else {
                    let field = text(&input, "field");
                    if ![
                        "title",
                        "description",
                        "source",
                        "backend",
                        "chatInstructions",
                    ]
                    .contains(&field)
                    {
                        return Err("Invalid draft field".into());
                    }
                    let search = text(&input, "search");
                    let source = text(&draft["content"], field);
                    if search.is_empty() || source.matches(search).count() != 1 {
                        return Err("Search must match exactly once".into());
                    }
                    draft["content"][field] =
                        json!(source.replacen(search, text(&input, "replace"), 1));
                }
                draft["revision"] = json!(draft["revision"].as_i64().unwrap() + 1);
                draft.as_object_mut().unwrap().remove("prepared");
                store.json_save("build_drafts", &self.chat, &draft)?;
                Ok(json!({"revision":draft["revision"],"tested":false}))
            }
            "test_draft" => {
                let _permit = self
                    .app
                    .actions
                    .try_acquire()
                    .map_err(|_| "App server is busy")?;
                let content = &draft["content"];
                backend::validate_frontend(text(content, "source"))?;
                backend::validate_utilities(text(content, "source"), &self.app.assets)?;
                if text(content, "backend").is_empty() && draft["baseVersion"] == 0 {
                    return Err("New apps require a backend with behavioral tests".into());
                }
                let (tests, catalog) = if text(content, "backend").is_empty() {
                    (vec![], vec![])
                } else {
                    match backend::test(text(content, "backend")).await {
                        Ok(output) => (output.report, output.catalog),
                        Err(error) => {
                            return Ok(
                                json!({"revision":draft["revision"],"passed":false,"phase":"backend","error":crate::diagnostics::sanitize(&json!(error),0)}),
                            )
                        }
                    }
                };
                draft["prepared"] = json!({"title":content["title"],"description":content["description"],"source":content["source"],"bundle":content["source"],"backend":text(content,"backend"),"backendBundle":text(content,"backend"),"testReport":json!(tests).to_string(),"actionContract":backend::contract(text(content,"backend"),&catalog).to_string(),"chatInstructions":text(content,"chatInstructions"),"frontendFormat":"preact-htm","requestedChange":approved["summary"]});
                store.json_save("build_drafts", &self.chat, &draft)?;
                Ok(
                    json!({"revision":draft["revision"],"passed":true,"tests":tests,"coverage":{"frontendSyntaxChecked":true,"browserWorkflowsTested":false}}),
                )
            }
            "publish_draft" => {
                let result = store.publish_draft(&self.space, &self.chat, approved, &draft)?;
                let target = text(&result, "spaceId");
                if let Err(error) = automation::notify(
                    store,
                    target,
                    &json!({"key":"app:published","title":"Your app is ready","body":"Open your app from Home."}),
                ) {
                    // Publication has committed. Notification failure must not claim it failed.
                    crate::diagnostics::log(
                        store,
                        "publication.notification_failed",
                        json!({"spaceId":target,"error":error}),
                    );
                }
                Ok(result)
            }
            "debug_draft_action" => {
                let data = serde_json::from_str(text(&input, "inputJSON"))
                    .map_err(|_| "Invalid inputJSON")?;
                let mut result = backend::debug(
                    text(&draft["content"], "backend"),
                    text(&input, "action"),
                    data,
                    vec![],
                    input["mockHttp"].as_array().cloned().unwrap_or_default(),
                )
                .await?;
                result["revision"] = draft["revision"].clone();
                Ok(result)
            }
            "test_draft_connection" => {
                if draft["prepared"].is_null() {
                    return Err("Test this exact draft before checking its live connection".into());
                }
                let source = backend::source(&draft["prepared"]);
                let contract: Value =
                    serde_json::from_str(text(&draft["prepared"], "actionContract"))
                        .map_err(|_| "Invalid draft action contract")?;
                let catalog = contract["actions"]
                    .as_array()
                    .ok_or("Invalid draft action catalog")?
                    .clone();
                let action = catalog
                    .iter()
                    .find(|a| text(a, "name") == text(&input, "action"))
                    .ok_or("Unknown action")?;
                if action["readOnly"] != json!(true) {
                    return Err("Connection checks must be read-only".into());
                }
                let rows = store
                    .applet_id(&self.space)
                    .ok()
                    .and_then(|id| store.records(&id).ok())
                    .unwrap_or_default();
                let data = serde_json::from_str(text(&input, "inputJSON"))
                    .map_err(|_| "Invalid inputJSON")?;
                backend::probe_source(
                    store,
                    text(&draft, "target"),
                    source,
                    &catalog,
                    text(&input, "action"),
                    data,
                    rows,
                )
                .await
            }
            _ => Err("Unknown draft operation".into()),
        }
    }
}
