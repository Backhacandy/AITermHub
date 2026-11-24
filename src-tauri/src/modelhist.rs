// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 에이전트가 예전에 실제로 쓴 모델 찾기: 라이트로 바꾸며 낮아진 모델을 원래대로 되돌릴 때,
//! 원래 모델 기록이 없던 팀은 대화 기록에서 "그 시각 전에 마지막으로 쓴 모델"을 읽는다.
//! Claude: ~/.claude/projects/*/<id>.jsonl 의 assistant message.model · Codex: rollout의 turn_context payload.model

use std::path::PathBuf;

/// 기록 줄들에서 before(ms) 전에 마지막으로 쓴 모델
fn last_model_before(lines: impl Iterator<Item = String>, before_ms: i64, codex: bool) -> Option<String> {
    let mut last = None;
    for line in lines {
        if !line.contains("\"model\"") {
            continue;
        }
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ts = j["timestamp"].as_str().and_then(|t| chrono_ms(t));
        if ts.map(|t| t >= before_ms).unwrap_or(true) {
            continue;
        }
        let m = if codex {
            (j["type"] == "turn_context").then(|| j["payload"]["model"].as_str()).flatten()
        } else {
            (j["type"] == "assistant").then(|| j["message"]["model"].as_str()).flatten()
        };
        if let Some(m) = m.filter(|m| !m.is_empty() && !m.starts_with('<')) {
            last = Some(m.to_string());
        }
    }
    last
}

/// "2026-11-11T16:31:36.547Z" → 유닉스 ms(UTC만)
fn chrono_ms(t: &str) -> Option<i64> {
    let t = t.strip_suffix('Z')?;
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut h = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (h.next()??, h.next()??, h.next()??);
    let ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse::<i64>().ok()?;
    // 1970-01-01부터 날짜 수(그레고리력)
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 12) } else { (y, mo) };
    let days = 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 + (153 * (m2 - 3) + 2) / 5 + da - 719469;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

fn claude_file(id: &str) -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var("USERPROFILE").ok()?).join(".claude").join("projects");
    // 작업 폴더로 옮기며 복사한 기록이 여럿일 수 있다 — 가장 긴 것(가장 많이 이어 쓴 것)
    std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path().join(format!("{id}.jsonl")))
        .filter(|p| p.is_file())
        .max_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0))
}

/// 이 대화가 before(ms) 전에 마지막으로 쓴 모델(없으면 None)
#[tauri::command(async)]
pub fn session_model_before(cli: String, id: String, before: i64) -> Option<String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let codex = cli == "codex";
    let f = if codex { crate::codex::session_file(&id)? } else { claude_file(&id)? };
    let text = std::fs::read_to_string(f).ok()?;
    last_model_before(text.lines().map(str::to_string), before, codex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_timestamps() {
        assert_eq!(chrono_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(chrono_ms("2026-11-11T16:31:36.547Z"), Some(1_794_414_696_547));
        assert_eq!(chrono_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        assert_eq!(chrono_ms("2026-11-11 16:31"), None);
    }

    #[test]
    fn last_model_before_the_switch() {
        let claude = [
            r#"{"type":"assistant","timestamp":"2026-11-10T00:00:00.000Z","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-10T01:00:00.000Z","message":{"model":"<synthetic>"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-12T00:00:00.000Z","message":{"model":"claude-sonnet-5"}}"#,
        ];
        let cut = chrono_ms("2026-11-11T00:00:00.000Z").unwrap();
        assert_eq!(last_model_before(claude.iter().map(|s| s.to_string()), cut, false).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(last_model_before(claude.iter().map(|s| s.to_string()), 0, false), None);
        let codex = [r#"{"type":"turn_context","timestamp":"2026-11-08T10:41:22.508Z","payload":{"model":"gpt-6-astra"}}"#];
        assert_eq!(last_model_before(codex.iter().map(|s| s.to_string()), cut, true).as_deref(), Some("gpt-6-astra"));
    }
}
