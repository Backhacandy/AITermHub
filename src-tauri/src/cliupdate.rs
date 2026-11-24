// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! Claude Code·Codex CLI 자동 업데이트: 버전을 읽고(--version), 업데이트를 돌린 뒤 다시 읽어 결과를 돌려준다.
//! Claude는 `claude update`, Codex는 npm 전역 설치라 `npm i -g @openai/codex@latest`.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;

const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct CliUpdate {
    pub cli: String,
    pub before: String,
    pub after: String,
    pub ok: bool,
    pub message: String,
}

/// 버전 글에서 숫자 버전만(예: "2.1.322 (Claude Code)" → "2.1.322", "codex-cli 0.167.0" → "0.167.0")
pub fn parse_version(s: &str) -> String {
    s.split_whitespace()
        .find(|w| w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && w.contains('.'))
        .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-').to_string())
        .unwrap_or_default()
}

/// cmd를 거쳐 실행(npm·codex는 .cmd 껍데기라 직접 실행이 안 된다). 인자는 모두 고정 문자열이다
fn run(args: &[&str]) -> Result<String, String> {
    let out = Command::new("cmd")
        .arg("/C")
        .args(args)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().lines().last().unwrap_or("실패").to_string())
    }
}

fn version(cli: &str) -> String {
    run(&[cli, "--version"]).map(|s| parse_version(&s)).unwrap_or_default()
}

/// cli: "claude" | "codex"
#[tauri::command(async)]
pub fn cli_update(cli: String) -> Result<CliUpdate, String> {
    let update: &[&str] = match cli.as_str() {
        "claude" => &["claude", "update"],
        "codex" => &["npm", "i", "-g", "@openai/codex@latest"],
        _ => return Err("모르는 CLI".into()),
    };
    let before = version(&cli);
    if before.is_empty() {
        return Ok(CliUpdate { cli, before, after: String::new(), ok: false, message: "설치돼 있지 않아요".into() });
    }
    let res = run(update);
    let after = version(&cli);
    Ok(match res {
        Ok(_) => CliUpdate { message: if after != before { format!("{before} → {after}") } else { format!("최신이에요({after})") }, cli, before, after, ok: true },
        Err(e) => CliUpdate { cli, before, after, ok: false, message: e },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versions() {
        assert_eq!(parse_version("2.1.322 (Claude Code)"), "2.1.322");
        assert_eq!(parse_version("codex-cli 0.167.0\n"), "0.167.0");
        assert_eq!(parse_version("codex-cli 0.168.0-alpha.2"), "0.168.0-alpha.2");
        assert_eq!(parse_version("명령을 찾을 수 없음"), "");
    }
}
