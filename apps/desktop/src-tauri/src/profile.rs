use crate::host::{Failure, Result};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub config_version: u32,
    pub vault_path: PathBuf,
    pub data_dir: PathBuf,
    pub host: String,
    pub port: u16,
}

pub fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn future_directory(path: &Path) -> std::io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(error)?;
            Ok(future_directory(parent)?.join(path.file_name().unwrap_or_default()))
        }
        Err(error) => Err(error),
    }
}

pub fn read_regular(path: &Path, max: u64) -> Result<String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| Failure::new("CONFIG_ERROR", "Runtime metadata is unavailable"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(Failure::new(
                "INSTANCE_UNCERTAIN",
                "Runtime metadata is a reparse point",
            ));
        }
    }
    if !meta.is_file() || meta.len() > max {
        return Err(Failure::new(
            "INSTANCE_UNCERTAIN",
            "Runtime metadata is not a bounded regular file",
        ));
    }
    fs::read_to_string(path)
        .map_err(|_| Failure::new("CONFIG_ERROR", "Runtime metadata cannot be read"))
}

impl Profile {
    pub fn load(path: &Path) -> Result<Self> {
        let mut value: Self = serde_json::from_str(&read_regular(path, 16384)?)
            .map_err(|_| Failure::new("CONFIG_ERROR", "Invalid profile JSON or fields"))?;
        if value.config_version != 1
            || value.host != "127.0.0.1"
            || value.port == 0
            || !value.vault_path.is_absolute()
            || !value.data_dir.is_absolute()
        {
            return Err(Failure::new(
                "CONFIG_ERROR",
                "Profile requires absolute directories and a fixed loopback address",
            ));
        }
        value.vault_path = fs::canonicalize(&value.vault_path)
            .map_err(|_| Failure::new("CONFIG_ERROR", "Vault directory is unavailable"))?;
        value.data_dir = future_directory(&value.data_dir)
            .map_err(|_| Failure::new("CONFIG_ERROR", "Data directory is unavailable"))?;
        let vault = path_key(&value.vault_path);
        let data = path_key(&value.data_dir);
        if !value.vault_path.is_dir()
            || vault == data
            || vault.starts_with(&(data.clone() + "\\"))
            || data.starts_with(&(vault + "\\"))
        {
            return Err(Failure::new(
                "CONFIG_ERROR",
                "Vault and data directories must be disjoint",
            ));
        }
        Ok(value)
    }
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}
