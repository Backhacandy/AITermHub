// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 백엔드 공통 유틸: CLI 인자 검증, Claude 프로젝트 폴더명 인코딩, 큰 파일 끝부분 읽기, 경로 경계 검사.

use std::path::{Path, PathBuf};

/// cmd.exe를 거쳐 전달되는 인자(모델명 등)가 안전한 문자만 쓰는지 검사.
/// cmd는 `& | < > ^ % "` 등을 해석하므로 영숫자와 `. _ - : [ ] /`만 허용한다.
/// 생각 깊이(Claude `--effort`)로 받는 값
pub const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// 생각 깊이(Codex `model_reasoning_effort`)로 받는 값
pub const CODEX_EFFORTS: &[&str] = &["low", "medium", "high"];

/// 목록에 있는 생각 깊이만 통과(비었거나 모르는 값이면 None → CLI 설정 파일 값을 따른다)
pub fn pick_effort<'a>(e: Option<&'a str>, allowed: &[&str]) -> Option<&'a str> {
    e.filter(|x| allowed.contains(x))
}

pub fn safe_arg(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '[' | ']' | '/'))
}

/// 선택형 인자를 허용 목록으로 검사.
pub fn one_of(s: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&s) {
        Ok(())
    } else {
        Err(format!("허용되지 않은 값: {s}"))
    }
}

/// Claude Code가 ~/.claude/projects/<이름> 폴더를 만들 때와 같은 규칙:
/// 영숫자가 아닌 모든 문자(`:` `\` 공백 `.` `_` 한글 등)를 `-`로 바꾼다.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// ~/.claude/projects/<인코딩된 cwd>
pub fn claude_project_dir(cwd: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(cwd))
}

/// 파일 끝부분 최대 cap 바이트를 읽는다. 중간부터 읽었으면 깨진 첫 줄을 버린다.
/// (대화 기록 jsonl은 수십~수백 MB까지 커질 수 있다.)
pub fn read_tail(path: &Path, cap: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(cap);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        Some(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default())
    } else {
        Some(text)
    }
}

/// 파일 앞부분 cap 바이트(끝의 잘린 줄은 버림). 큰 기록의 첫 메시지만 볼 때.
pub fn read_head(path: &Path, cap: usize) -> String {
    use std::io::Read;
    let mut buf = Vec::with_capacity(cap.min(1 << 20));
    let n = std::fs::File::open(path).and_then(|f| f.take(cap as u64).read_to_end(&mut buf)).unwrap_or(0);
    let s = String::from_utf8_lossy(&buf).into_owned();
    if n < cap { s } else { s.rsplit_once('\n').map(|(a, _)| a.to_string()).unwrap_or_default() }
}

/// 끝부분을 1MB부터 4배씩 넓혀(최대 `max`) 읽고 `parse`한다. `enough`가 참이 되거나 파일 처음까지 읽으면 멈춘다.
/// 대화 기록 끝이 큰 도구 결과로 차 있으면 1MB 안에 대화 글이 거의 없을 수 있어서다.
pub fn tail_parse<T>(path: &Path, max: u64, parse: impl Fn(&str) -> T, enough: impl Fn(&T) -> bool) -> Option<T> {
    let len = std::fs::metadata(path).ok()?.len();
    let mut cap: u64 = 1_000_000;
    loop {
        let v = parse(&read_tail(path, cap)?);
        if enough(&v) || cap >= len || cap >= max {
            return Some(v);
        }
        cap = (cap * 4).min(max);
    }
}

/// 파일에서 `marker`가 마지막으로 나온 위치 이후의 바이트 수(없으면 파일 전체 크기).
/// 끝에서부터 1MB씩 거꾸로 훑어 수백 MB 파일도 빠르게 처리한다.
pub fn bytes_after_last(path: &Path, marker: &[u8]) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 1_000_000;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let overlap = marker.len() as u64;
    let mut end = len;
    while end > 0 {
        let start = end.saturating_sub(CHUNK);
        // 경계에 걸친 marker를 놓치지 않도록 뒤쪽 청크와 marker 길이만큼 겹쳐 읽는다
        let read_end = (end + overlap).min(len);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; (read_end - start) as usize];
        f.read_exact(&mut buf).ok()?;
        if let Some(pos) = buf.windows(marker.len()).rposition(|w| w == marker) {
            return Some(len - (start + pos as u64));
        }
        end = start;
    }
    Some(len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_only_known_values() {
        assert_eq!(pick_effort(Some("xhigh"), CLAUDE_EFFORTS), Some("xhigh"));
        assert_eq!(pick_effort(Some("max"), CODEX_EFFORTS), None);
        assert_eq!(pick_effort(Some(""), CLAUDE_EFFORTS), None);
        assert_eq!(pick_effort(Some("high; rm"), CLAUDE_EFFORTS), None);
        assert_eq!(pick_effort(None, CODEX_EFFORTS), None);
    }

    #[test]
    fn project_dir_name_matches_claude_code() {
        assert_eq!(claude_project_dir_name(r"C:\AITermHub"), "C--AITermHub");
        assert_eq!(claude_project_dir_name(r"C:\my proj\a_b.c"), "C--my-proj-a-b-c");
        assert_eq!(claude_project_dir_name(r"D:\작업\x"), "D-----x");
    }

    #[test]
    fn safe_arg_rejects_cmd_metachars() {
        assert!(safe_arg("opus"));
        assert!(safe_arg("claude-opus-5-5[1m]"));
        assert!(safe_arg("gpt-6.1-sol"));
        for bad in ["a&b", "a|b", "x\"y", "%PATH%", "a^b", "a b", "", "a>b"] {
            assert!(!safe_arg(bad), "{bad}");
        }
    }

    #[test]
    fn bytes_after_last_marker() {
        let p = std::env::temp_dir().join(format!("aith-marker-{}.jsonl", std::process::id()));
        std::fs::write(&p, "aaaa\nMARK one\nbbbb\nMARK two\ncc\n").unwrap();
        // 마지막 "MARK" 시작부터 끝까지 = "MARK two\ncc\n" = 12바이트, 없으면 파일 전체(31바이트)
        assert_eq!(bytes_after_last(&p, b"MARK"), Some(12));
        assert_eq!(bytes_after_last(&p, b"NOPE"), Some(31));
        let _ = std::fs::remove_file(&p);
    }
}
