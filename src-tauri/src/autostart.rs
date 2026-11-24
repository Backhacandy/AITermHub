// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 컴퓨터 시작 시 자동 실행: HKCU\...\Run 에 `"<exe>" --autostart` 등록(관리자 권한 불필요).
//! `--autostart`로 켜지면 메인 창을 최소화해서 띄운다(lib.rs setup).

use std::process::Command;

const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const NAME: &str = "AITermHub";
pub const FLAG: &str = "--autostart";

/// Run 키에 넣을 값
pub fn run_value(exe: &str) -> String {
    format!("\"{exe}\" {FLAG}")
}

fn reg(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    Command::new("reg").args(args).creation_flags(0x0800_0000).output()
}

/// 지금 실행 중인 exe로 등록돼 있는지
pub fn get() -> bool {
    let Ok(out) = reg(&["query", KEY, "/v", NAME]) else { return false };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
    !exe.is_empty() && text.contains(&exe)
}

pub fn set(on: bool) -> Result<(), String> {
    let out = if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let v = run_value(&exe.to_string_lossy());
        reg(&["add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", &v, "/f"])
    } else {
        reg(&["delete", KEY, "/v", NAME, "/f"])
    }
    .map_err(|e| e.to_string())?;
    // 끌 때 값이 원래 없으면 실패가 나지만 결과는 같다
    if out.status.success() || !on {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 이번 실행이 자동 시작으로 켜진 것인지
pub fn launched_by_autostart() -> bool {
    std::env::args().any(|a| a == FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn value_quotes_path_and_adds_flag() {
        assert_eq!(run_value(r"C:\Program Files\AITermHub\aitermhub.exe"), r#""C:\Program Files\AITermHub\aitermhub.exe" --autostart"#);
    }
}
