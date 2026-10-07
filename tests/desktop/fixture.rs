use engramweave_desktop::host::Host;
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Fixture {
    pub root: PathBuf,
    pub config: PathBuf,
    pub profile: Value,
    pub original: Vec<u8>,
}
impl Fixture {
    pub fn new() -> Self {
        let canonical = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let workspace = PathBuf::from(canonical.to_string_lossy().trim_start_matches(r"\\?\"));
        let name = format!(
            "desktop-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = workspace.join(".local/test-runs").join(name);
        fs::create_dir_all(root.join("vault/20_Sources")).unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let source = fs::read_to_string(workspace.join(".local/fixtures/r1-vault/20_Sources/Web/2026-10/并发编程（七）：volatile——从语言规则到 CPU.md")).unwrap();
        let original = if source.starts_with("---\r\n") {
            source.replacen("---\r\n", "---\r\nprocessing_status: pending\r\n", 1)
        } else {
            source.replacen("---\n", "---\nprocessing_status: pending\n", 1)
        }.into_bytes();
        fs::write(root.join("vault/20_Sources/r1.md"), &original).unwrap();
        let profile = json!({"config_version":1,"vault_path":root.join("vault"),"data_dir":root.join("data"),"host":"127.0.0.1","port":port});
        let config = root.join("config.json");
        fs::write(&config, serde_json::to_vec(&profile).unwrap()).unwrap();
        Self {
            root,
            config,
            profile,
            original,
        }
    }
    pub fn host(&self) -> Host {
        Host::new(self.config.clone())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // A second panic during unwinding aborts the whole MSVC test process.
        // Preserve failed fixtures so the original failure remains diagnosable.
        if std::thread::panicking() {
            eprintln!("Preserving failed Desktop fixture: {}", self.root.display());
            return;
        }
        assert!(
            fs::read(self.root.join("vault/20_Sources/r1.md")).unwrap() == self.original,
            "Desktop fixture asset bytes changed"
        );
        remove_isolated_fixture(&self.root);
    }
}

fn remove_isolated_fixture(root: &std::path::Path) {
    let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.local/test-runs")
        .canonicalize()
        .unwrap();
    let root = root.canonicalize().unwrap();
    assert!(root.starts_with(&parent) && root != parent);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_fixture_cleanup_preserves_the_original_panic_and_success_still_checks_bytes() {
    for already_panicking in [true, false] {
        let fixture = Fixture::new();
        let root = fixture.root.clone();
        let result = std::panic::catch_unwind(move || {
            fs::write(
                fixture.root.join("vault/20_Sources/r1.md"),
                b"isolated injected edit",
            )
            .unwrap();
            if already_panicking {
                panic!("injected original test failure");
            }
            drop(fixture);
        });
        assert!(result.is_err());
        if already_panicking {
            assert_eq!(
                result.unwrap_err().downcast_ref::<&str>(),
                Some(&"injected original test failure")
            );
        }
        assert!(
            root.exists(),
            "Failed fixture must remain available for inspection"
        );
        assert_eq!(
            fs::read(root.join("vault/20_Sources/r1.md")).unwrap(),
            b"isolated injected edit"
        );
        remove_isolated_fixture(&root);
    }
}
