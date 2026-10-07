use super::fixture::Fixture;
use engramweave_desktop::{
    open::{document_uri, OpenTarget},
    routes::{route, Operation},
};
use serde_json::json;
use std::{fs, net::TcpListener};

#[test]
fn fixed_bridge_rejects_arbitrary_paths_headers_and_job_route_injection() {
    for input in [
        json!({"url":"http://example.com"}),
        json!({"authorization":"secret"}),
        json!({"file":"C:/private"}),
    ] {
        assert_eq!(
            route(Operation::Status, &input).unwrap_err().code,
            "VALIDATION_ERROR"
        );
    }
    assert!(route(Operation::Job, &json!({"id":"../status"})).is_err());
    assert!(route(Operation::Search, &json!({"scope":{}})).is_err());
    assert_eq!(
        route(Operation::Document, &json!({"path":"20_Sources/r1.md"}))
            .unwrap()
            .1,
        "/v1/documents"
    );
}

#[test]
fn wrong_instance_descriptor_is_refused_without_stopping_core() {
    let fixture = Fixture::new();
    let mut external = fixture.host();
    external.start().unwrap();
    let descriptor = fixture.root.join("data/instance.lock");
    let original = fs::read(&descriptor).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    value["vault_path_key"] = json!("c:\\different-vault");
    fs::write(&descriptor, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut desktop = fixture.host();
    assert_eq!(desktop.connect().unwrap_err().code, "INSTANCE_UNCERTAIN");
    fs::write(&descriptor, original).unwrap();
    assert_eq!(
        external.request(Operation::Status, json!({})).unwrap()["status"],
        "ready"
    );
    external.stop().unwrap();
}

#[test]
fn port_conflict_and_residual_lock_are_preserved() {
    let fixture = Fixture::new();
    let port = fixture.profile["port"].as_u64().unwrap() as u16;
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let mut desktop = fixture.host();
    assert_eq!(desktop.start().unwrap_err().code, "PORT_CONFLICT");
    assert!(!fixture.root.join("data").exists());
    drop(listener);
    fs::create_dir(fixture.root.join("data")).unwrap();
    fs::write(fixture.root.join("data/instance.lock"), b"uncertain").unwrap();
    assert_eq!(desktop.start().unwrap_err().code, "INSTANCE_UNCERTAIN");
    assert_eq!(
        fs::read(fixture.root.join("data/instance.lock")).unwrap(),
        b"uncertain"
    );
    assert_eq!(desktop.info()["mode"], "disconnected");
}

#[test]
fn native_open_builds_encoded_obsidian_uri_and_allows_only_original_webpage() {
    let fixture = Fixture::new();
    let mut desktop = fixture.host();
    desktop.start().unwrap();
    let uri = document_uri(
        &mut desktop,
        "20_Sources/r1.md".into(),
        OpenTarget::Obsidian,
    )
    .unwrap();
    assert!(uri.starts_with("obsidian://open?"));
    assert!(uri.contains("vault=vault"));
    assert!(uri.contains("file=20_Sources%2Fr1.md"));
    fs::write(
        fixture.root.join("vault/20_Sources/spaced name.md"),
        "---\ntype: raw_source\nsource_type: manual\ncaptured_at: 2026-10-03\n---\nbody",
    )
    .unwrap();
    let spaced_uri = document_uri(
        &mut desktop,
        "20_Sources/spaced name.md".into(),
        OpenTarget::Obsidian,
    )
    .unwrap();
    assert!(spaced_uri.contains("file=20_Sources%2Fspaced%20name.md"));
    assert!(!spaced_uri.contains('+'));
    let original = document_uri(
        &mut desktop,
        "20_Sources/r1.md".into(),
        OpenTarget::Original,
    )
    .unwrap();
    assert_eq!(original, "https://www.cnblogs.com/ThinkerQAQ/p/23192943");
    fs::write(fixture.root.join("vault/20_Sources/unsafe.source.md"), "---\ntype: raw_source\nsource_type: manual\nasset: zotero://select/items/ABC\nsource: javascript:alert(1)\n---\nRecord").unwrap();
    assert_eq!(
        desktop
            .request(
                Operation::Document,
                json!({"path":"20_Sources/unsafe.source.md"})
            )
            .unwrap()["original_locator"],
        "javascript:alert(1)"
    );
    assert_eq!(
        document_uri(
            &mut desktop,
            "20_Sources/unsafe.source.md".into(),
            OpenTarget::Original
        )
        .unwrap_err()
        .code,
        "VALIDATION_ERROR"
    );
    assert!(document_uri(&mut desktop, "../secret.md".into(), OpenTarget::Obsidian).is_err());
    desktop.stop().unwrap();
}

#[test]
fn changing_profile_requires_desktop_restart() {
    let fixture = Fixture::new();
    let mut desktop = fixture.host();
    desktop.start().unwrap();
    desktop.stop().unwrap();
    let mut changed = fixture.profile.clone();
    changed["port"] = json!(43129);
    fs::write(&fixture.config, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(desktop.start().unwrap_err().code, "CONFIG_ERROR");
}

#[test]
fn compiler_settings_native_bridge_keeps_credentials_write_only() {
    let fixture = Fixture::new();
    let mut desktop = fixture.host();
    desktop.start().unwrap();
    let input = json!({"settings": {"route":"api","model":"fixture-model","endpoint":"http://127.0.0.1:8094/v1","codex_path":"","output_format":"text","reasoning_effort":"none","timeout_seconds":60}, "api_key":"native-fixture-secret"});
    let saved = desktop.request(Operation::CompilerSettingsWrite, input).unwrap();
    assert_eq!(saved["api_key_configured"], true);
    assert!(!saved.to_string().contains("native-fixture-secret"));
    let read = desktop.request(Operation::CompilerSettings, json!({})).unwrap();
    assert!(!read.to_string().contains("native-fixture-secret"));
    assert!(!fs::read_to_string(fixture.root.join("data/compiler-api-key.dpapi")).unwrap().contains("native-fixture-secret"));
    assert!(desktop.request(Operation::Compile, json!({"path":"20_Sources/r1.md","revision":"a".repeat(64),"request_id":"00000000-0000-0000-0000-000000000001","command":"forbidden"})).is_err());
    desktop.stop().unwrap();
}

#[test]
fn source_filters_preview_and_batch_use_the_fixed_native_bridge() {
    let fixture = Fixture::new();
    let mut desktop = fixture.host();
    desktop.start().unwrap();
    let scan = desktop.request(Operation::Scan, json!({"mode":"refresh"})).unwrap();
    for _ in 0..100 {
        let job = desktop.request(Operation::Job, json!({"id":scan["job"]["id"]})).unwrap();
        if job["status"] == "succeeded" { break; }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let list = desktop.request(Operation::Sources, json!({"view":"pending","types":"[\"web\",\"manual\"]","sort":"captured_desc"})).unwrap();
    assert_eq!(list["total"], 1);
    let preview = desktop.request(Operation::DiscardPreview, json!({"path":"20_Sources/r1.md"})).unwrap();
    assert_eq!(preview["source"]["path"], "20_Sources/r1.md");
    let id = "00000000-0000-0000-0000-000000000010";
    desktop.request(Operation::SourceBatch, json!({"id":id,"action":"restore","items":[{"path":"20_Sources/r1.md","revision":preview["source"]["revision"],"request_id":"00000000-0000-0000-0000-000000000011"}]})).unwrap();
    let mut result = serde_json::Value::Null;
    for _ in 0..100 {
        result = desktop.request(Operation::SourceBatchStatus, json!({"id":id})).unwrap();
        if result["status"] != "running" { break; }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(result["status"], "completed");
    assert_eq!(result["items"][0]["status"], "succeeded");
    assert!(desktop.request(Operation::SourceBatch, json!({"id":id,"action":"restore","items":[],"headers":{}})).is_err());
    desktop.stop().unwrap();
}
