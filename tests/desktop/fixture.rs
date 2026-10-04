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
        let original = fs::read(workspace.join(".local/fixtures/r1-vault/20_Sources/Web/2026-10/并发编程（七）：volatile——从语言规则到 CPU.md")).unwrap();
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
        assert_eq!(
            fs::read(self.root.join("vault/20_Sources/r1.md")).unwrap(),
            self.original
        );
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local/test-runs")
            .canonicalize()
            .unwrap();
        let root = self.root.canonicalize().unwrap();
        assert!(root.starts_with(&parent) && root != parent);
        fs::remove_dir_all(root).unwrap();
    }
}
