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
