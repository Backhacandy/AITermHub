// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 설정 영속화: app_data_dir/settings.json 에 JSON으로 저장/로드.
//! 모니터가 3초마다 읽으므로 메모리에 캐시하고, 저장할 때만 디스크에 쓴다.

use std::path::PathBuf;
use std::sync::Mutex;

static CACHE: Mutex<Option<Value>> = Mutex::new(None);

use anyhow::Result;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn file_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// 기본 설정.
pub fn default_settings() -> Value {
    json!({
        "theme": "dark",
        "fontSize": 14,
        "autoSleep": true,
        "idleMinutes": 15,
        "commands": {
            "claude": ["/clear", "/compact", "/model", "/config", "/help"],
            "codex": ["/clear", "/compact", "/model", "/approvals", "/help"],
            "powershell": ["cls", "ls", "git status"]
        }
    })
}

/// 설정 로드(없으면 기본값). 첫 호출 이후엔 캐시에서.
pub fn load(app: &AppHandle) -> Value {
    if let Some(v) = CACHE.lock().unwrap().as_ref() {
        return v.clone();
    }
    let v = file_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(default_settings);
    *CACHE.lock().unwrap() = Some(v.clone());
    v
}

/// 설정 저장(전체 객체 교체).
pub fn save(app: &AppHandle, value: &Value) -> Result<()> {
    let p = file_path(app)?;
    std::fs::write(p, serde_json::to_string_pretty(value)?)?;
    *CACHE.lock().unwrap() = Some(value.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_sleep_on_by_default() {
        assert_eq!(default_settings()["autoSleep"], true);
    }
}
