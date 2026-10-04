use crate::{
    host::{Failure, Host, Result},
    routes::Operation,
};
use serde::Deserialize;
use serde_json::json;
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenTarget {
    Obsidian,
    Original,
}

pub fn document_uri(host: &mut Host, path: String, target: OpenTarget) -> Result<String> {
    // Core validates scope and the current document; the webview cannot supply a URI.
    let document = host.request(Operation::Document, json!({"path": path}))?;
    match target {
        OpenTarget::Obsidian => {
            let status = host.request(Operation::Status, json!({}))?;
            let vault = status["vault_path"]
                .as_str()
                .ok_or_else(|| Failure::new("INSTANCE_UNCERTAIN", "Vault is unavailable"))?;
            let vault_name = std::path::Path::new(
                vault.trim_start_matches(r"\\?\").trim_end_matches(['/', '\\']),
            )
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Failure::new("INSTANCE_UNCERTAIN", "Vault name is unavailable"))?;
            let mut uri = Url::parse("obsidian://open").unwrap();
            uri.query_pairs_mut()
                .append_pair("vault", vault_name)
                .append_pair("file", &path);
            Ok(uri.to_string().replace('+', "%20"))
        }
        OpenTarget::Original => {
            let locator = document["original_locator"].as_str().ok_or_else(|| {
                Failure::new("VALIDATION_ERROR", "This document has no original webpage")
            })?;
            let uri = Url::parse(locator).map_err(|_| {
                Failure::new("VALIDATION_ERROR", "Original locator is not a webpage URL")
            })?;
            if !["http", "https"].contains(&uri.scheme())
                || uri.host_str().is_none()
                || !uri.username().is_empty()
                || uri.password().is_some()
            {
                return Err(Failure::new(
                    "VALIDATION_ERROR",
                    "Only HTTP and HTTPS webpages without credentials can be opened",
                ));
            }
            Ok(uri.to_string())
        }
    }
}

pub fn launch(uri: &str) -> Result<()> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let wide: Vec<u16> = uri.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(Failure::new(
            "IO_ERROR",
            "No registered application could open this document",
        ));
    }
    Ok(())
}
