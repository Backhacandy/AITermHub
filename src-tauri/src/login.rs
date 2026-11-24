// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! CLI 로그인 여부: 각 CLI의 상태 명령(claude auth status · codex login status)에게 묻는다.
//! 로그인 정보 파일은 읽지 않는다. 출력은 여기서 참/거짓으로만 바꾸고 밖으로 내보내지 않는다(이메일 등이 들어 있을 수 있음).
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const NO_WINDOW: u32 = 0x0800_0000;

/// 상태 명령(고정 인자만). 모르는 CLI는 None — 상태 명령이 없으면 "확인 못 함"
fn status_args(cli: &str) -> Option<&'static [&'static str]> {
    match cli {
        "claude" => Some(&["claude", "auth", "status"]),
        "codex" => Some(&["codex", "login", "status"]),
        _ => None,
    }
}

/// 상태 명령 결과 → 로그인 여부(판단 못 하면 None)
pub fn parse_login(cli: &str, ok: bool, text: &str) -> Option<bool> {
    match cli {
        "claude" => {
            let t = text.replace(' ', "");
            if t.contains("\"loggedIn\":true") {
                Some(true)
            } else if t.contains("\"loggedIn\":false") {
                Some(false)
            } else {
                None
            }
        }
        "codex" => {
            let t = text.to_lowercase();
            if t.contains("not logged in") {
                Some(false)
            } else if ok && t.contains("logged in") {
                Some(true)
            } else if !ok {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// cli: "claude" | "codex". 로그인됨 true · 안 됨 false · 확인 못 함 null
#[tauri::command(async)]
pub fn cli_login(cli: String) -> Option<bool> {
    let args = status_args(&cli)?;
    let mut child = Command::new("cmd")
        .arg("/C")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(NO_WINDOW)
        .spawn()
        .ok()?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < Duration::from_secs(10) => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    };
    let mut text = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut text);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut text);
    }
    parse_login(&cli, status.success(), &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_json() {
        assert_eq!(parse_login("claude", true, "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}"), Some(true));
        assert_eq!(parse_login("claude", false, "{ \"loggedIn\": false }"), Some(false));
        assert_eq!(parse_login("claude", false, "error: unknown command 'auth'"), None);
    }

    #[test]
    fn codex_text() {
        assert_eq!(parse_login("codex", true, "Logged in using ChatGPT\n"), Some(true));
        assert_eq!(parse_login("codex", false, "Not logged in\n"), Some(false));
        assert_eq!(parse_login("codex", true, ""), None);
    }

    #[test]
    fn unknown_cli() {
        assert_eq!(parse_login("gemini", true, "anything"), None);
        assert!(status_args("gemini").is_none());
        assert!(status_args("rm -rf").is_none());
    }
}
