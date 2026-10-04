use super::fixture::Fixture;
use engramweave_desktop::{host::Host, routes::Operation};
use serde_json::json;
use std::{fs, thread, time::Duration};

#[test]
fn owned_core_scans_and_stops_gracefully_without_touching_vault() {
    let fixture = Fixture::new();
    let mut host = fixture.host();
    let started = host.start().unwrap();
    assert_eq!(started["host"]["mode"], "owned");
    assert_eq!(started["status"]["index_generation"], 0);
    assert!(!started
        .to_string()
        .contains(&fs::read_to_string(fixture.root.join("data/token")).unwrap()));
    let scan = host
        .request(Operation::Scan, json!({"mode":"refresh"}))
        .unwrap();
    let id = scan["job"]["id"].clone();
    let mut succeeded = false;
    for _ in 0..100 {
        let job = host.request(Operation::Job, json!({"id":id})).unwrap();
        if job["status"] == "succeeded" {
            succeeded = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(succeeded);
    let hits = host
        .request(Operation::Search, json!({"scope":"sources","q":"volatile"}))
        .unwrap();
    assert_eq!(hits["total"], 1);
    host.stop().unwrap();
    assert!(!fixture.root.join("data/instance.lock").exists());
    assert_eq!(host.info()["mode"], "disconnected");
}

#[test]
fn attached_host_cannot_stop_external_core_and_drop_preserves_it() {
    let fixture = Fixture::new();
    let mut external = fixture.host();
    external.start().unwrap();
    {
        let mut desktop = fixture.host();
        assert_eq!(desktop.start().unwrap_err().code, "PORT_CONFLICT");
        assert_eq!(desktop.connect().unwrap()["host"]["mode"], "attached");
        assert_eq!(desktop.stop().unwrap_err().code, "INSTANCE_UNCERTAIN");
    }
    assert_eq!(
        external.request(Operation::Status, json!({})).unwrap()["status"],
        "ready"
    );
    external.stop().unwrap();
}

#[test]
fn instance_replacement_requires_reconnect_and_owned_drop_releases_lock() {
    let fixture = Fixture::new();
    let mut desktop = fixture.host();
    {
        let mut external = fixture.host();
        external.start().unwrap();
        desktop.connect().unwrap();
    }
    assert_eq!(
        desktop
            .request(Operation::Status, json!({}))
            .unwrap_err()
            .code,
        "CORE_UNAVAILABLE"
    );
    let mut replacement = fixture.host();
    replacement.start().unwrap();
    assert_eq!(
        desktop
            .request(Operation::Status, json!({}))
            .unwrap_err()
            .code,
        "CORE_UNAVAILABLE"
    );
    assert_eq!(desktop.connect().unwrap()["host"]["mode"], "attached");
    replacement.stop().unwrap();
    assert!(!fixture.root.join("data/instance.lock").exists());
    drop(Host::new(fixture.config.clone()));
}
