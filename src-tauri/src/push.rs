// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 폰 푸시 알림(ntfy): 폰에 ntfy 앱을 깔고 같은 주제를 구독하면 작업 완료·한도 소진을 받는다.
//! 내용은 짧은 제목·본문만 보낸다(코드·답변 전문은 보내지 않음). Windows 기본 curl.exe로 JSON을 POST한다.

use std::io::Write;
use std::process::{Command, Stdio};

/// 주제 이름: 추측하기 어렵게 영문·숫자·-·_ 8자 이상(ntfy 주제는 이름만 알면 누구나 구독 가능)
pub fn valid_topic(t: &str) -> bool {
    t.len() >= 8 && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn valid_server(s: &str) -> bool {
    (s.starts_with("https://") || s.starts_with("http://")) && !s.contains(char::is_whitespace)
}

pub fn payload(topic: &str, title: &str, body: &str, priority: u8) -> String {
    serde_json::json!({ "topic": topic, "title": title, "message": body, "priority": priority }).to_string()
}

fn send(server: &str, json: &str) -> Result<(), String> {
    let mut cmd = Command::new("curl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .args(["-s", "-S", "-f", "-m", "10", "-H", "Content-Type: application/json", "--data-binary", "@-", server.trim_end_matches('/')])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl 실행 실패: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("푸시 전송 실패: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[tauri::command]
pub async fn notify_push(server: String, topic: String, title: String, body: String, priority: Option<u8>) -> Result<(), String> {
    if !valid_topic(&topic) {
        return Err("주제 이름은 영문·숫자·-·_ 8자 이상이어야 해요".into());
    }
    if !valid_server(&server) {
        return Err("서버 주소는 https://로 시작해야 해요".into());
    }
    let json = payload(&topic, &title, &body, priority.unwrap_or(3).clamp(1, 5));
    tauri::async_runtime::spawn_blocking(move || send(&server, &json))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_and_server_rules() {
        assert!(valid_topic("aith-3fk29xq7"));
        assert!(!valid_topic("short"));
        assert!(!valid_topic("has space here"));
        assert!(!valid_topic("한글주제이름이에요요"));
        assert!(valid_server("https://ntfy.sh"));
        assert!(!valid_server("ntfy.sh"));
    }

    #[test]
    fn payload_escapes_text() {
        let p = payload("aith-abcdefgh", "MyGame · Claude 완료", "줄1\n\"따옴표\"", 3);
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["message"], "줄1\n\"따옴표\"");
        assert_eq!(v["topic"], "aith-abcdefgh");
    }
}
