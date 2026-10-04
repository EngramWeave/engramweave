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
    assert!(uri.contains("file=20_Sources%2Fr1.md"));
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
