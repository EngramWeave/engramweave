use crate::host::{Failure, Result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Status,
    Sources,
    Jobs,
    Job,
    Document,
    Search,
    Scan,
    CompilerSettings,
    CompilerSettingsWrite,
    Compile,
    Drafts,
    Draft,
    SourceBatch,
    SourceBatchStatus,
    DiscardPreview,
    RecallSettings,
    RecallSettingsWrite,
    RecallTest,
    RecallStatus,
    RecallIndex,
    Recall,
    RecallContext,
}

pub fn route(operation: Operation, input: &Value) -> Result<(bool, String, Vec<(String, String)>)> {
    let (post, route, allowed): (bool, &str, &[&str]) = match operation {
        Operation::Status => (false, "/v1/status", &[]),
        Operation::Sources => (
            false,
            "/v1/sources",
            &["state", "source_type", "path_prefix", "limit", "offset", "view", "q", "types", "tags", "stages", "issues", "captured_from", "captured_to", "time_ranges", "sort"],
        ),
        Operation::Jobs => (false, "/v1/jobs", &["limit", "offset"]),
        Operation::Job => (false, "/v1/jobs/", &["id"]),
        Operation::Document => (false, "/v1/documents", &["path"]),
        Operation::Search => (
            false,
            "/v1/search",
            &[
                "q",
                "scope",
                "fields",
                "source_type",
                "tag",
                "path_prefix",
                "limit",
                "offset",
            ],
        ),
        Operation::Scan => (true, "/v1/scans", &["mode"]),
        Operation::CompilerSettings => (false, "/v1/compiler/settings", &[]),
        Operation::CompilerSettingsWrite => (true, "/v1/compiler/settings", &["settings", "api_key"]),
        Operation::Compile => (true, "/v1/compilations", &["path", "revision", "request_id"]),
        Operation::Drafts => (false, "/v1/drafts", &["source_path"]),
        Operation::Draft => (false, "/v1/draft", &["path"]),
        Operation::SourceBatch => (true, "/v1/source-batches", &["id", "action", "items"]),
        Operation::SourceBatchStatus => (false, "/v1/source-batches", &["id"]),
        Operation::DiscardPreview => (false, "/v1/source-discard-preview", &["path"]),
        Operation::RecallSettings => (false, "/v1/recall/settings", &[]),
        Operation::RecallSettingsWrite => (true, "/v1/recall/settings", &["settings", "api_key", "reranker_key"]),
        Operation::RecallTest => (true, "/v1/recall/test", &[]),
        Operation::RecallStatus => (false, "/v1/recall/status", &[]),
        Operation::RecallIndex => (true, "/v1/recall/index", &["mode"]),
        Operation::Recall => (true, "/v1/recall", &["q", "scope", "limit", "rerank"]),
        Operation::RecallContext => (true, "/v1/recall/context", &["items"]),
    };
    let object = input
        .as_object()
        .ok_or_else(|| Failure::new("VALIDATION_ERROR", "Bridge input must be an object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Failure::new(
            "VALIDATION_ERROR",
            "Bridge field is not permitted",
        ));
    }
    if post && route.starts_with("/v1/recall") {
        if serde_json::to_vec(input).map(|bytes| bytes.len() > 32768).unwrap_or(true) {
            return Err(Failure::new("VALIDATION_ERROR", "Recall request exceeds its bound"));
        }
        return Ok((true, route.to_string(), vec![]));
    }
    if route == "/v1/compiler/settings" && post {
        if !object.get("settings").map(Value::is_object).unwrap_or(false)
            || object.get("api_key").map(|key| !key.is_string() || key.as_str().unwrap_or("").len() > 8192).unwrap_or(false)
        { return Err(Failure::new("VALIDATION_ERROR", "Invalid Compiler settings input")); }
        return Ok((true, route.to_string(), vec![]));
    }
    if route == "/v1/source-batches" && post {
        if !object.get("id").map(Value::is_string).unwrap_or(false)
            || !object.get("action").map(Value::is_string).unwrap_or(false)
            || !object.get("items").and_then(Value::as_array).map(|items| !items.is_empty() && items.len() <= 100).unwrap_or(false)
        { return Err(Failure::new("VALIDATION_ERROR", "Invalid Source batch input")); }
        return Ok((true, route.to_string(), vec![]));
    }
    let mut query = Vec::new();
    for (key, value) in object {
        let value = match value {
            Value::String(value) => value.clone(),
            Value::Number(value) if value.is_u64() => value.to_string(),
            _ => {
                return Err(Failure::new(
                    "VALIDATION_ERROR",
                    "Invalid bridge field type",
                ))
            }
        };
        if value.len() > 4096 {
            return Err(Failure::new(
                "VALIDATION_ERROR",
                "Bridge field exceeds its bound",
            ));
        }
        query.push((key.clone(), value));
    }
    if route == "/v1/jobs/" {
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::new("VALIDATION_ERROR", "Job ID is required"))?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(Failure::new("VALIDATION_ERROR", "Invalid job ID"));
        }
        return Ok((false, format!("{route}{id}"), vec![]));
    }
    Ok((post, route.to_string(), query))
}
