fn main() {
    for name in ["ENGRAMWEAVE_NODE", "ENGRAMWEAVE_CORE_ENTRY"] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name)
            .expect("Use npm run desktop:dev or desktop:build to lock the runtime");
        let path = std::fs::canonicalize(value).expect("Locked runtime path must exist");
        // Node's main-entry resolver does not accept Windows extended-length prefixes.
        println!(
            "cargo:rustc-env={name}={}",
            path.to_string_lossy().trim_start_matches(r"\\?\")
        );
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "host_info",
            "core_connect",
            "core_start",
            "core_stop",
            "core_request",
            "open_document",
        ]),
    ))
    .expect("Tauri build failed");
}
