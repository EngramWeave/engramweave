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
}

pub fn route(operation: Operation, input: &Value) -> Result<(bool, String, Vec<(String, String)>)> {
    let (post, route, allowed): (bool, &str, &[&str]) = match operation {
        Operation::Status => (false, "/v1/status", &[]),
        Operation::Sources => (
            false,
            "/v1/sources",
            &["state", "source_type", "path_prefix", "limit", "offset"],
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
    if route == "/v1/compiler/settings" && post {
        if !object.get("settings").map(Value::is_object).unwrap_or(false)
            || object.get("api_key").map(|key| !key.is_string() || key.as_str().unwrap_or("").len() > 8192).unwrap_or(false)
        { return Err(Failure::new("VALIDATION_ERROR", "Invalid Compiler settings input")); }
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
