// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 팀 탭의 "하던 일"(돌던 에이전트 · 팀장에게 아직 못 간 결과 · 팀장이 답하던 차례)을 파일로 남긴다.
//! 앱이 업데이트·꺼짐으로 다시 켜지면 이걸 한 번 가져가 팀장에게 이어서 맡긴다(가져가면 지운다).
//! app_data/flight/<폴더 키>.json — 화면이 몇 초마다 바뀐 것만 쓴다.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// 폴더 경로 → 파일 이름(소문자, 영문·숫자 말고는 -). 같은 폴더면 \ / 끝 슬래시와 상관없이 같은 키
pub fn key(dir: &str) -> String {
    let d = dir.trim().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let mut out = String::new();
    for c in d.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    // 한글 폴더 등 영문이 거의 없으면 겹칠 수 있어 원래 경로의 해시를 붙인다
    let h = d.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    let head: String = out.chars().take(80).collect();
    format!("{head}-{:08x}", h as u32)
}

fn path(app: &AppHandle, dir: &str) -> Option<PathBuf> {
    let root = app.path().app_data_dir().ok()?.join("flight");
    std::fs::create_dir_all(&root).ok()?;
    Some(root.join(format!("{}.json", key(dir))))
}

/// value가 null이면 지운다(하던 일이 없음)
#[tauri::command]
pub fn team_flight_save(app: AppHandle, dir: String, value: Option<Value>) -> Result<(), String> {
    let p = path(&app, &dir).ok_or("앱 데이터 폴더를 못 찾았어요")?;
    match value {
        Some(v) if !v.is_null() => {
            let tmp = p.with_extension("tmp");
            std::fs::write(&tmp, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
        }
        _ => {
            let _ = std::fs::remove_file(&p);
            Ok(())
        }
    }
}

/// 남겨 둔 것을 한 번 가져간다(읽고 지움). 없거나 깨졌으면 None
#[tauri::command]
pub fn team_flight_take(app: AppHandle, dir: String) -> Option<Value> {
    let p = path(&app, &dir)?;
    let text = std::fs::read_to_string(&p).ok()?;
    let _ = std::fs::remove_file(&p);
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_folder_same_key() {
        assert_eq!(key("C:\\Luck"), key("c:/luck/"));
        assert!(key("C:\\Luck").starts_with("c-luck-"));
        assert_ne!(key("C:\\Luck"), key("C:\\Luck2"));
        // 영문이 없는 폴더끼리도 겹치지 않는다
        assert_ne!(key("C:\\게임"), key("C:\\소설"));
        assert!(key("C:\\게임").chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
