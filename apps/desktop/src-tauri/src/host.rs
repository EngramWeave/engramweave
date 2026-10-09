use crate::{
    profile::{path_key, read_regular, Profile},
    routes::{route, Operation},
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}
impl Failure {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

#[derive(Deserialize)]
struct Descriptor {
    instance_id: String,
    pid: u32,
    api_version: String,
    host: String,
    port: u16,
    vault_path_key: String,
    data_dir_key: String,
}
#[derive(Clone)]
struct Connection {
    profile: Profile,
    token: String,
    instance_id: String,
}

pub struct Host {
    pub profile_path: PathBuf,
    client: Client,
    connection: Option<Connection>,
    frozen_profile: Option<Profile>,
    child: Option<Child>,
    startup_error: Arc<Mutex<Option<Failure>>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
}

impl Host {
    pub fn new(profile_path: PathBuf) -> Self {
        Self {
            profile_path,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(1))
                .build()
                .expect("Local HTTP client"),
            connection: None,
            frozen_profile: None,
            child: None,
            startup_error: Arc::new(Mutex::new(None)),
            stderr_reader: None,
        }
    }
    pub fn info(&self) -> Value {
        json!({ "profile_path": self.profile_path, "node_path": env!("ENGRAMWEAVE_NODE"), "core_entry": env!("ENGRAMWEAVE_CORE_ENTRY"), "mode": if self.child.is_some() { "owned" } else if self.connection.is_some() { "attached" } else { "disconnected" } })
    }
    fn http(
        &self,
        profile: &Profile,
        token: Option<&str>,
        post: bool,
        route: &str,
        query: &[(String, String)],
        body: Option<&Value>,
    ) -> Result<Value> {
        let url = format!("{}{route}", profile.base());
        let mut request = if post {
            self.client.post(url)
        } else {
            self.client.get(url)
        };
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request = request.query(query);
        if route == "/v1/recall" || route == "/v1/recall/test" {
            request = request.timeout(Duration::from_secs(610));
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|_| {
            Failure::new(
                "CORE_UNAVAILABLE",
                "Core connection failed; reconnect explicitly",
            )
        })?;
        let status = response.status();
        let value: Value = response.json().map_err(|_| {
            Failure::new(
                "INSTANCE_UNCERTAIN",
                "Local service returned an invalid response",
            )
        })?;
        if !status.is_success() {
            if let Some(error) = value.get("error") {
                if let (Some(code), Some(message)) =
                    (error["code"].as_str(), error["message"].as_str())
                {
                    return Err(Failure {
                        code: code.into(),
                        message: message.into(),
                        details: error.get("details").filter(|v| !v.is_null()).cloned(),
                    });
                }
            }
            return Err(Failure::new("CORE_UNAVAILABLE", "Core is not ready"));
        }
        Ok(value)
    }
    fn handshake(&self, profile: Profile) -> Result<(Connection, Value)> {
        let health = self.http(&profile, None, false, "/v1/health", &[], None)?;
        if health["api_version"] != "1" || health["status"] != "ready" {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Core API version or readiness differs",
            ));
        }
        let descriptor: Descriptor = serde_json::from_str(&read_regular(
            &profile.data_dir.join("instance.lock"),
            8192,
        )?)
        .map_err(|_| Failure::new("INSTANCE_UNCERTAIN", "Invalid instance descriptor"))?;
        if descriptor.api_version != "1"
            || descriptor.host != "127.0.0.1"
            || descriptor.port != profile.port
            || descriptor.vault_path_key != path_key(&profile.vault_path)
            || descriptor.data_dir_key != path_key(&profile.data_dir)
            || descriptor.pid == 0
        {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Instance descriptor does not match this profile",
            ));
        }
        if self
            .child
            .as_ref()
            .is_some_and(|child| child.id() != descriptor.pid)
        {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Running instance is not the owned child",
            ));
        }
        let token = read_regular(&profile.data_dir.join("token"), 64)?;
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Invalid native authentication token",
            ));
        }
        let status = self.http(&profile, Some(&token), false, "/v1/status", &[], None)?;
        if status["api_version"] != "1"
            || status["status"] != "ready"
            || status["instance_id"] != descriptor.instance_id
            || status["database_initialized"] != true
            || status["vault_path"]
                .as_str()
                .map(|value| path_key(&PathBuf::from(value)))
                != Some(path_key(&profile.vault_path))
            || status["data_dir"]
                .as_str()
                .map(|value| path_key(&PathBuf::from(value)))
                != Some(path_key(&profile.data_dir))
        {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Authenticated Core identity or Vault differs",
            ));
        }
        Ok((
            Connection {
                profile,
                token,
                instance_id: descriptor.instance_id,
            },
            status,
        ))
    }
    fn check_child(&mut self) -> Result<()> {
        if let Some(child) = &mut self.child {
            if child
                .try_wait()
                .map_err(|_| Failure::new("IO_ERROR", "Cannot inspect owned child"))?
                .is_some()
            {
                self.child = None;
                self.connection = None;
                if let Some(reader) = self.stderr_reader.take() {
                    let _ = reader.join();
                }
                return Err(self
                    .startup_error
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| Failure::new("CORE_UNAVAILABLE", "Owned Core exited")));
            }
        }
        Ok(())
    }
    pub fn connect(&mut self) -> Result<Value> {
        self.check_child()?;
        let profile = self.load_profile()?;
        let (connection, status) = self.handshake(profile)?;
        self.connection = Some(connection);
        Ok(json!({ "host": self.info(), "status": status }))
    }
    pub fn start(&mut self) -> Result<Value> {
        self.check_child()?;
        if self.child.is_some() || self.connection.is_some() {
            return self.connect();
        }
        let profile = self.load_profile()?;
        // A responsive port must be attached explicitly, never claimed or replaced.
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", profile.port).parse().unwrap(),
            Duration::from_millis(300),
        )
        .is_ok()
        {
            return Err(Failure::new(
                "PORT_CONFLICT",
                "Configured port is occupied; use Connect to verify the existing Core",
            ));
        }
        let version = Command::new(env!("ENGRAMWEAVE_NODE"))
            .arg("--version")
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| Failure::new("CONFIG_ERROR", "Locked Node executable is unavailable"))?;
        if !version.status.success()
            || version.stdout != b"v24.19.0\r\n" && version.stdout != b"v24.19.0\n"
        {
            return Err(Failure::new("CONFIG_ERROR", "Locked Node version differs"));
        }
        *self.startup_error.lock().unwrap() = None;
        let mut child = Command::new(env!("ENGRAMWEAVE_NODE"))
            .arg(env!("ENGRAMWEAVE_CORE_ENTRY"))
            .args(["--config"])
            .arg(&self.profile_path)
            .env("ENGRAMWEAVE_HOST_STDIN", "1")
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| Failure::new("CONFIG_ERROR", "Cannot start the locked Core entry"))?;
        let stderr = child.stderr.take().unwrap();
        let errors = self.startup_error.clone();
        self.stderr_reader = Some(thread::spawn(move || {
            for line in BufReader::new(stderr).lines().take(10).flatten() {
                if line.len() > 16384 {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value["event"] == "core_failed" {
                        let code = value["code"].as_str().unwrap_or("CORE_UNAVAILABLE");
                        *errors.lock().unwrap() = Some(Failure { code: code.into(), message: "Core startup or shutdown failed; inspect the configured data directory".into(), details: value.get("details").cloned() });
                    }
                }
            }
        }));
        self.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if let Err(error) = self.check_child() {
                return Err(error);
            }
            if let Ok((connection, status)) = self.handshake(profile.clone()) {
                self.connection = Some(connection);
                return Ok(json!({ "host": self.info(), "status": status }));
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.stop();
        Err(Failure::new(
            "CORE_UNAVAILABLE",
            "Core did not complete the identity handshake within the startup timeout",
        ))
    }
    fn load_profile(&mut self) -> Result<Profile> {
        let profile = Profile::load(&self.profile_path)?;
        if let Some(frozen) = &self.frozen_profile {
            if profile.port != frozen.port
                || path_key(&profile.vault_path) != path_key(&frozen.vault_path)
                || path_key(&profile.data_dir) != path_key(&frozen.data_dir)
            {
                return Err(Failure::new(
                    "CONFIG_ERROR",
                    "Profile changed; restart Desktop to select different directories or port",
                ));
            }
        } else {
            self.frozen_profile = Some(profile.clone());
        }
        Ok(profile)
    }
    pub fn stop(&mut self) -> Result<Value> {
        if let Some(mut child) = self.child.take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(b"{\"type\":\"stop\"}\n");
            }
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(50))
                    }
                    _ => {
                        if child.kill().is_err() || child.wait().is_err() {
                            self.child = Some(child);
                            return Err(Failure::new(
                                "IO_ERROR",
                                "Cannot stop or wait for owned Core handle",
                            ));
                        }
                        break;
                    }
                }
            }
            self.connection = None;
            if let Some(reader) = self.stderr_reader.take() {
                let _ = reader.join();
            }
        } else {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Desktop may stop only its owned child; external Core remains running",
            ));
        }
        Ok(self.info())
    }
    // Model waits use a connection snapshot, without holding the Desktop lifecycle mutex.
    // The ordinary request still verifies the instance descriptor and token at use time.
    pub fn recall_connection(&mut self) -> Result<Host> {
        self.check_child()?;
        let mut snapshot = Host::new(self.profile_path.clone());
        snapshot.connection = Some(self.connection.as_ref().ok_or_else(|| Failure::new("CORE_UNAVAILABLE", "Connect Core explicitly"))?.clone());
        snapshot.frozen_profile = self.frozen_profile.clone();
        Ok(snapshot)
    }
    pub fn request(&mut self, operation: Operation, input: Value) -> Result<Value> {
        self.check_child()?;
        let (post, route, query) = route(operation, &input)?;
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| Failure::new("CORE_UNAVAILABLE", "Connect or start Core explicitly"))?;
        let result = (|| {
            let (identity, _) = self.handshake(connection.profile.clone())?;
            if identity.instance_id != connection.instance_id {
                return Err(Failure::new(
                    "INSTANCE_UNCERTAIN",
                    "Core instance changed; reconnect explicitly",
                ));
            }
            self.http(
                &connection.profile,
                Some(&connection.token),
                post,
                &route,
                if post { &[] } else { &query },
                if post { Some(&input) } else { None },
            )
        })();
        if result.as_ref().err().is_some_and(|error| {
            ["CORE_UNAVAILABLE", "INSTANCE_UNCERTAIN", "UNAUTHORIZED"]
                .contains(&error.code.as_str())
        }) {
            self.connection = None;
        }
        result
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        if self.child.is_some() {
            let _ = self.stop();
        }
    }
}
#[cfg(windows)]
use std::os::windows::process::CommandExt;
