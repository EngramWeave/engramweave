pub mod host;
pub mod open;
pub mod profile;
pub mod routes;

use host::{Failure, Host, Result};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

type HostState = Arc<Mutex<Host>>;
async fn with_host<T: Send + 'static>(
    state: &HostState,
    operation: impl FnOnce(&mut Host) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut host = state
            .lock()
            .map_err(|_| Failure::new("IO_ERROR", "Native host state is unavailable"))?;
        operation(&mut host)
    })
    .await
    .map_err(|_| Failure::new("IO_ERROR", "Native host operation failed"))?
}
#[tauri::command]
async fn host_info(state: State<'_, HostState>) -> Result<Value> {
    with_host(&state, |host| Ok(host.info())).await
}
#[tauri::command]
async fn core_connect(state: State<'_, HostState>) -> Result<Value> {
    with_host(&state, Host::connect).await
}
#[tauri::command]
async fn core_start(state: State<'_, HostState>) -> Result<Value> {
    with_host(&state, Host::start).await
}
#[tauri::command]
async fn core_stop(state: State<'_, HostState>) -> Result<Value> {
    with_host(&state, Host::stop).await
}
#[tauri::command]
async fn core_request(
    state: State<'_, HostState>,
    operation: routes::Operation,
    input: Value,
) -> Result<Value> {
    with_host(&state, move |host| host.request(operation, input)).await
}
#[tauri::command]
async fn open_document(
    state: State<'_, HostState>,
    path: String,
    target: open::OpenTarget,
) -> Result<()> {
    with_host(&state, move |host| {
        open::launch(&open::document_uri(host, path, target)?)
    })
    .await
}

pub fn run() {
    let profile = std::env::var_os("ENGRAMWEAVE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
                .join("EngramWeave/p1/config.json")
        });
    let state: HostState = Arc::new(Mutex::new(Host::new(profile)));
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host_info,
            core_connect,
            core_start,
            core_stop,
            core_request,
            open_document
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || url.scheme() == "http"
                            && (url.host_str() == Some("tauri.localhost")
                                || cfg!(dev)
                                    && url.host_str() == Some("127.0.0.1")
                                    && url.port() == Some(1420))
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Desktop initialization failed")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Ok(mut host) = app.state::<HostState>().lock() {
                    if host.info()["mode"] == "owned" {
                        let _ = host.stop();
                    }
                }
            }
        });
}
