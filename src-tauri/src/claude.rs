// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! Claude 구조화 세션: `claude -p --input/output-format stream-json`을 파이프로 구동.
//! stdout의 JSON 이벤트는 "claude-event"로 emit, 사용자 메시지는 stdin에 JSON으로 전송.
//!
//! 모든 이벤트에는 `gen`(시작 세대 번호)이 붙는다. 같은 탭에서 재시작하면 이전 프로세스의
//! 늦은 이벤트(특히 claude-exit)가 새 세션을 "종료됨"으로 오인하지 않도록 프론트가 걸러낸다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// message.content에서 사람이 읽을 텍스트만 뽑는다(문자열 또는 text 블록들).
fn extract_text(msg: Option<&Value>) -> String {
    let Some(m) = msg else { return String::new() };
    match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 프로그램이 대화에 끼워 넣는 메타 메시지(슬래시 명령 출력, 시스템 알림 등)인지.
fn is_meta_text(text: &str) -> bool {
    let t = text.trim_start();
    ["<command-", "<local-command", "<system-reminder", "<bash-", "<task-notification", "Caveat: The messages below"]
        .iter()
        .any(|p| t.starts_with(p))
}

/// cwd의 Claude 대화 기록(jsonl)에서 user/assistant 텍스트를 최대 limit개 반환.
/// `session`이 있으면 그 세션 파일을, 없으면 가장 최근 파일을 읽는다.
/// 반환: {"sessionId": 파일명(=세션 id) 또는 null, "messages": [{role, text}], "bytes": 마지막 압축 이후 기록 크기,
///        "ctx": 마지막 API 호출의 문맥 토큰(압축 여부를 비용으로 판단하는 데 씀)}
/// (bytes는 "이어서" 시작 때 대화가 커서 먼저 압축할지 판단하는 데 쓴다. 압축 전 대화도 파일에 남아 있으므로
///  파일 전체 크기로 판단하면 이미 압축된 대화를 또 압축하게 된다 → 마지막 compact_boundary 이후만 센다)
/// 이 폴더에서 가장 최근에 대화한 기록 파일.
/// `claude remote-control`이 시작할 때마다 만드는 빈 기록처럼 대화(user/assistant)가 없는 파일은 건너뛴다
/// — 그걸 고르면 "이어서"가 빈 대화가 되어 기억이 사라진 것처럼 보인다.
fn latest_session(dir: &Path) -> Option<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if m.len() == 0 {
                return None;
            }
            Some((m.modified().ok()?, e.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|(_, p)| p).find(|p| {
        crate::util::read_tail(p, 200_000)
            .map(|c| c.contains("\"type\":\"user\"") || c.contains("\"type\":\"assistant\""))
            .unwrap_or(false)
    })
}

pub fn transcript(cwd: &str, session: Option<&str>, limit: usize) -> Value {
    let empty = json!({ "sessionId": null, "messages": [], "bytes": 0 });
    let dir = crate::util::claude_project_dir(cwd);

    let path = match session.filter(|s| crate::util::safe_arg(s)) {
        Some(s) => dir.join(format!("{s}.jsonl")),
        None => match latest_session(&dir) {
            Some(p) => p,
            None => return empty,
        },
    };
    let session_id = path.file_stem().map(|s| s.to_string_lossy().to_string());
    let Some((out, ctx)) = transcript_at(&path, limit) else { return empty };
    let start = out.len().saturating_sub(limit);
    let bytes = crate::util::bytes_after_last(&path, br#""subtype":"compact_boundary""#).unwrap_or(0);
    json!({ "sessionId": session_id, "messages": out[start..].to_vec(), "bytes": bytes, "ctx": ctx })
}

/// 자동 압축 창(토큰): 이 크기를 창으로 보고 Claude Code가 일하는 도중에도 스스로 압축한다(CLAUDE_CODE_AUTO_COMPACT_WINDOW).
/// 1M 창 모델이 50만 토큰 넘게 지난 대화를 끌고 다니지 않게 팀 에이전트에 준다. 너무 작으면 압축만 되풀이해 멈추므로(thrashing) 5만~100만만 받는다
pub fn compact_env(window: Option<u32>) -> Option<(String, String)> {
    window.filter(|w| (50_000..=1_000_000).contains(w)).map(|w| ("CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(), w.to_string()))
}

/// 분배·팀 제안용 단발 호출 인자: 도구·MCP·사용자 설정 없이, 기록 안 남기고, 스키마대로 JSON.
pub fn oneshot_args(model: &str, system: &str, schema: &Value) -> Vec<String> {
    [
        "-p", "--output-format", "json", "--json-schema", &schema.to_string(), "--tools", "", "--strict-mcp-config",
        "--setting-sources", "", "--no-session-persistence", "--model", model, "--system-prompt", system,
        // 생각을 줄여야 몇 초 안에 끝난다(실측: 기본 22초 → low 4.5초)
        "--effort", "low",
    ]
    .map(String::from)
    .to_vec()
}

/// 한 번 묻고 구조화 결과(JSON)를 받는다(분배 Sonnet·구성 Opus). 프롬프트는 stdin, 180초 넘으면 끊는다.
pub fn oneshot(cwd: &str, model: &str, system: &str, prompt: &str, schema: &Value, env: Vec<(String, String)>) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    let (exe, pre) = crate::collab::resolve_cli("claude");
    let mut cmd = Command::new(exe);
    cmd.creation_flags(0x0800_0000)
        .args(pre)
        .args(oneshot_args(model, system, schema))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for k in ["CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
        cmd.env_remove(k);
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("claude 실행 실패: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = match rx.recv_timeout(std::time::Duration::from_secs(180)) {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => {
            crate::procctl::kill_tree(pid);
            return Err("시간 초과(180초)".into());
        }
    };
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        format!("결과를 읽지 못했어요: {}", err.trim().chars().take(200).collect::<String>())
    })?;
    if v["is_error"].as_bool() == Some(true) {
        return Err(v["result"].as_str().unwrap_or("실패").to_string());
    }
    if v["structured_output"].is_object() {
        return Ok(v["structured_output"].clone());
    }
    // 구조화 결과가 없으면 답 글에서 JSON을 찾는다
    let text = v["result"].as_str().unwrap_or("");
    let (a, b) = (text.find('{'), text.rfind('}'));
    match (a, b) {
        (Some(a), Some(b)) if b > a => serde_json::from_str(&text[a..=b]).map_err(|e| e.to_string()),
        _ => Err("JSON 결과가 없어요".into()),
    }
}

/// 이 폴더의 Claude 대화 목록(사용자가 이어 갈 대화를 직접 고르는 용도). 최근 것부터 limit개.
pub fn sessions(cwd: &str, limit: usize) -> Value {
    json!(sessions_in(&crate::util::claude_project_dir(cwd), limit))
}

fn clip(s: &str, n: usize) -> String {
    let t = s.trim().replace(['\r', '\n'], " ");
    if t.chars().count() > n { format!("{}…", t.chars().take(n).collect::<String>()) } else { t }
}

/// 기록 한 부분에서 첫 사용자 글과 마지막 자동 제목
fn scan_meta(content: &str) -> (Option<String>, Option<String>) {
    let (mut first, mut title) = (None, None);
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("ai-title") => title = v.get("aiTitle").and_then(|x| x.as_str()).map(String::from).or(title),
            Some("user") if first.is_none() && v.get("isMeta").and_then(|x| x.as_bool()) != Some(true) => {
                let t = extract_text(v.get("message"));
                if !t.trim().is_empty() && !is_meta_text(&t) {
                    first = Some(t);
                }
            }
            _ => {}
        }
    }
    (first, title)
}

fn sessions_in(dir: &Path, limit: usize) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = rd
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if m.len() == 0 {
                return None;
            }
            Some((m.modified().ok()?, e.path(), m.len()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = Vec::new();
    for (t, p, size) in files {
        if out.len() >= limit {
            break;
        }
        let Some((msgs, _)) = crate::util::tail_parse(&p, 16_000_000, parse_transcript, |(m, _): &(Vec<Value>, u64)| !m.is_empty()) else { continue };
        let Some(last) = msgs.last() else { continue };
        let (first, head_title) = scan_meta(&crate::util::read_head(&p, 1_000_000));
        // 제목은 대화가 길어지면 다시 붙으므로 끝쪽 것을 우선
        let (_, tail_title) = crate::util::read_tail(&p, 1_000_000).map(|c| scan_meta(&c)).unwrap_or((None, None));
        let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        out.push(json!({
            "id": p.file_stem().map(|s| s.to_string_lossy().to_string()),
            "mtime": secs,
            "size": size,
            "title": tail_title.or(head_title),
            "first": first.map(|f| clip(&f, 300)),
            "last": clip(last["text"].as_str().unwrap_or(""), 200),
        }));
    }
    out
}

/// 기록을 끝에서부터 이만큼까지만 거슬러 읽는다(수백 MB 파일 전체를 읽으면 멈춤).
pub(crate) const TAIL_MAX: u64 = 64_000_000;

/// 기록 파일 끝부분에서 표시할 메시지와 마지막 API 호출의 문맥 크기.
/// 끝 1MB에 대화 글이 limit개보다 적으면(큰 도구 결과로 차 있으면) 더 거슬러 읽는다.
fn transcript_at(path: &Path, limit: usize) -> Option<(Vec<Value>, u64)> {
    crate::util::tail_parse(path, TAIL_MAX, parse_transcript, |(out, _)| out.len() >= limit)
}

fn parse_transcript(content: &str) -> (Vec<Value>, u64) {
    let mut out: Vec<Value> = Vec::new();
    // 마지막 API 호출의 문맥 크기(입력+캐시) — 압축 경계 뒤에 호출이 없으면 0(작다고 봄)
    let mut ctx: u64 = 0;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "system" && v.get("subtype").and_then(|x| x.as_str()) == Some("compact_boundary") {
            ctx = 0;
        }
        if t == "assistant" && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true) {
            if let Some(u) = v.pointer("/message/usage") {
                let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let c = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                if c > 0 {
                    ctx = c;
                }
            }
        }
        if t != "user" && t != "assistant" {
            continue;
        }
        if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let text = extract_text(v.get("message"));
        if !text.trim().is_empty() && !is_meta_text(&text) {
            out.push(json!({ "role": t, "text": text }));
        }
    }
    (out, ctx)
}

struct CSession {
    child: Child,
    stdin: ChildStdin,
    pid: u32,
    /** 쉬는 동안 일시정지(메모리 반납) 중인지 — 보내기 전에 깨운다 */
    suspended: bool,
}

#[derive(Default)]
pub struct ClaudeManager {
    sessions: Mutex<HashMap<String, CSession>>,
}

impl ClaudeManager {
    /// 세션 시작. `gen`은 프론트가 정한 세대 번호로 이 프로세스의 모든 이벤트에 실린다.
    /// `resume`이 있으면 그 세션 id를 정확히 이어가고(`--resume`), 없고 `cont`면 최근 세션(`--continue`).
    pub fn start(
        &self,
        app: &AppHandle,
        id: String,
        cwd: String,
        model: Option<String>,
        permission: String,
        cont: bool,
        resume: Option<String>,
        bare: bool,
        gen: u64,
        env: Vec<(String, String)>,
        lean: bool,
        effort: Option<String>,
        chrome: Option<bool>,
    ) -> Result<(), String> {
        // cmd.exe를 거치므로 사용자 입력 인자는 검증한다(명령 주입 방지).
        crate::util::one_of(&permission, &["", "default", "acceptEdits", "plan", "bypassPermissions"])?;
        if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
            if !crate::util::safe_arg(m) {
                return Err(format!("모델 이름에 허용되지 않는 문자: {m}"));
            }
        }
        let resume = resume.filter(|r| !r.is_empty());
        if let Some(r) = &resume {
            if !crate::util::safe_arg(r) {
                return Err("세션 id 형식 오류".into());
            }
        }
        // 이을 대화 기록이 없으면(대화 id만 받고 첫 글이 기록되기 전에 꺼진 경우 등) 새 대화로 —
        // 그대로 --resume 하면 "No conversation found with session ID"로 시작조차 못 한다
        let resume = pick_resume(&crate::util::claude_project_dir(&cwd), resume);
        // 같은 탭에서 재시작이면 이전 프로세스부터 정리
        self.stop(&id);

        let mut args: Vec<String> = vec![
            "/C".into(),
            "claude".into(),
            "-p".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            // 도구 입력(Write/Edit 내용)과 답변을 쓰는 도중에 받아 라이브로 보여준다
            "--include-partial-messages".into(),
        ];
        if bare {
            args.push("--bare".into());
        }
        // 팀 탭에서 추가한 칸: 사용자 MCP 서버(chrome-devtools 등)를 불러오지 않아 메모리를 아낀다
        if lean {
            args.push("--strict-mcp-config".into());
        }
        // Claude in Chrome: -p 모드에선 기본으로 꺼져 있다(추가한 칸에도 — --strict-mcp-config와 함께 써도 붙는다)
        if wants_chrome(&crate::registry::load(app), bare, chrome) {
            args.push("--chrome".into());
        }
        // 생각 깊이: 고르지 않으면 계정 설정 파일(effortLevel)을 따른다
        if let Some(e) = crate::util::pick_effort(effort.as_deref(), crate::util::CLAUDE_EFFORTS) {
            args.push("--effort".into());
            args.push(e.into());
        }
        // 허브 안내: GUI 프로그램은 aith-open으로(그냥 띄우면 턴 정리 때 함께 꺼짐), 테스트하며 사용자 화면을 빼앗지 않기
        // 싼 서브에이전트(탐색·실행)와 언제 맡길지 — 비싼 모델이 긴 탐색·로그를 직접 읽어 대화에 끌고 다니지 않게
        let agents = if bare { None } else { crate::tools::agents_file(app) };
        args.push("--append-system-prompt".into());
        args.push(if agents.is_some() { format!("{} {}", crate::tools::AGENT_HINT, crate::tools::DELEGATE_HINT) } else { crate::tools::AGENT_HINT.into() });
        if let Some(p) = agents {
            args.push("--agents".into());
            args.push(p.to_string_lossy().into_owned());
        }
        if let Some(r) = &resume {
            args.push("--resume".into());
            args.push(r.clone());
        } else if cont {
            args.push("--continue".into());
        }
        if permission == "bypassPermissions" {
            args.push("--dangerously-skip-permissions".into());
        } else if !permission.is_empty() && permission != "default" {
            args.push("--permission-mode".into());
            args.push(permission.clone());
        }
        if let Some(m) = &model {
            if !m.is_empty() {
                args.push("--model".into());
                args.push(m.clone());
            }
        }

        let mut cmd = Command::new("cmd");
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for k in [
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SSE_PORT",
        ] {
            cmd.env_remove(k);
        }
        // 계정 풀: 추가 계정이면 CLAUDE_CONFIG_DIR로 그 계정의 로그인을 쓴다
        for (k, v) in &env {
            cmd.env(k, v);
        }
        // 에이전트마다 임시 폴더 — 쓰고 버린 브라우저 프로필·빌드 임시 파일을 앱이 나중에 치울 수 있게(storage.rs)
        if let Some(t) = crate::storage::agent_tmp(&id) {
            cmd.env("TEMP", &t).env("TMP", &t);
        }

        let mut child = cmd.spawn().map_err(|e| format!("claude 실행 실패: {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("stdout 없음")?;
        let stdin = child.stdin.take().ok_or("stdin 없음")?;

        {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        if !l.trim().is_empty() {
                            let _ = app.emit("claude-event", json!({ "id": id, "gen": gen, "line": l }));
                        }
                    }
                }
                let _ = app.emit("claude-exit", json!({ "id": id, "gen": gen }));
            });
        }
        if let Some(serr) = child.stderr.take() {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(serr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        if !l.trim().is_empty() {
                            let _ = app.emit("claude-stderr", json!({ "id": id, "gen": gen, "line": l }));
                        }
                    }
                }
            });
        }

        self.sessions.lock().unwrap().insert(id, CSession { child, stdin, pid, suspended: false });
        Ok(())
    }

    pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
        let msg = json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        });
        self.write_line(id, &msg)
    }

    /// 진행 중인 답변 중단(stream-json 제어 요청). 프로세스·대화 맥락은 그대로 유지되고
    /// 이번 턴은 result(error_during_execution)로 끝난다.
    pub fn interrupt(&self, id: &str) -> Result<(), String> {
        let req = format!(
            "int_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let msg = json!({ "type": "control_request", "request_id": req, "request": { "subtype": "interrupt" } });
        self.write_line(id, &msg)
    }

    /// 쉬는 세션 재우기: 프로세스 트리를 일시정지하고 메모리를 반납한다(끄지 않으므로 대화·서버 캐시는 그대로).
    pub fn sleep(&self, id: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or("세션 없음")?;
        if !s.suspended {
            crate::procctl::suspend(s.pid).map_err(|e| e.to_string())?;
            s.suspended = true;
        }
        Ok(())
    }

    fn write_line(&self, id: &str, msg: &Value) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            // 재워 둔 세션이면 깨우고 보낸다
            if s.suspended {
                let _ = crate::procctl::resume(s.pid);
                s.suspended = false;
            }
            let line = format!("{}\n", msg);
            s.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            s.stdin.flush().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("세션 없음".into())
        }
    }

    pub fn stop(&self, id: &str) {
        let removed = self.sessions.lock().unwrap().remove(id);
        if let Some(mut s) = removed {
            // node 자식까지 트리 종료
            crate::procctl::kill_tree(s.pid);
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// 세션별 프로세스 트리 메모리(세션 상태 패널용).
    /// 세션의 루트 프로세스(cmd.exe) id
    pub fn pid_of(&self, id: &str) -> Option<u32> {
        self.sessions.lock().unwrap().get(id).map(|s| s.pid)
    }

    pub fn stats(&self) -> Vec<crate::pty::SessionStat> {
        let base: Vec<(String, u32, bool)> = self.sessions.lock().unwrap().iter().map(|(id, s)| (id.clone(), s.pid, s.suspended)).collect();
        base.into_iter()
            .map(|(id, pid, suspended)| crate::pty::SessionStat {
                rss: crate::procctl::working_set_bytes(pid),
                id,
                pid,
                suspended,
                pinned: false,
                note: None,
            })
            .collect()
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }
}

/// 이을 대화: 그 폴더 기록에 대화 파일이 있을 때만(없으면 None = 새 대화)
fn pick_resume(project_dir: &std::path::Path, resume: Option<String>) -> Option<String> {
    resume.filter(|r| project_dir.join(format!("{r}.jsonl")).exists())
}

/// Claude 세션에 Claude in Chrome을 켤지: 설정(claudeChrome, 기본 켬)이 상한이고, 팀(운영 방식·역할)은 좁힐 수만 있다.
/// --bare에는 안 붙인다
fn wants_chrome(settings: &serde_json::Value, bare: bool, force: Option<bool>) -> bool {
    !bare && settings["claudeChrome"].as_bool() != Some(false) && force.unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_window_env_only_in_safe_range() {
        assert_eq!(super::compact_env(Some(200_000)), Some(("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "200000".into())));
        assert_eq!(super::compact_env(None), None);
        assert_eq!(super::compact_env(Some(10_000)), None); // 압축만 되풀이(thrashing)
        assert_eq!(super::compact_env(Some(2_000_000)), None);
    }


    #[test]
    fn resume_only_when_the_conversation_file_exists() {
        let dir = std::env::temp_dir().join(format!("aith-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaa.jsonl"), "{}").unwrap();
        assert_eq!(pick_resume(&dir, Some("aaa".into())), Some("aaa".into()));
        assert_eq!(pick_resume(&dir, Some("db5f6fcf".into())), None);
        assert_eq!(pick_resume(&dir, None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chrome_on_unless_turned_off() {
        // -p 모드에선 Claude in Chrome이 기본으로 꺼져 있어 --chrome을 붙여야 쓸 수 있다
        assert!(wants_chrome(&serde_json::json!({}), false, None));
        assert!(wants_chrome(&serde_json::json!({ "claudeChrome": true }), false, None));
        assert!(!wants_chrome(&serde_json::json!({ "claudeChrome": false }), false, None));
        // --bare(최소 실행)에는 붙이지 않는다
        assert!(!wants_chrome(&serde_json::json!({}), true, None));
        // 팀이 정해 오면(라이트는 끔, 맥스는 역할만) 좁힐 수만 있다 — 사용자가 설정에서 끈 것은 팀장이 켤 수 없다
        assert!(!wants_chrome(&serde_json::json!({}), false, Some(false)));
        assert!(wants_chrome(&serde_json::json!({}), false, Some(true)));
        assert!(!wants_chrome(&serde_json::json!({ "claudeChrome": false }), false, Some(true)));
    }

    #[test]
    fn latest_session_skips_empty_and_message_less_files() {
        let dir = std::env::temp_dir().join(format!("aith-claude-latest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.jsonl");
        std::fs::write(&real, "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"안녕\"}}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        // 원격 제어가 만드는 빈 기록, 대화 없이 큐 기록만 있는 파일은 더 최근이어도 건너뛴다
        std::fs::write(dir.join("empty.jsonl"), "").unwrap();
        std::fs::write(dir.join("queue.jsonl"), "{\"type\":\"queue-operation\"}\n").unwrap();
        std::fs::write(dir.join("note.txt"), "x").unwrap();
        assert_eq!(latest_session(&dir).as_deref(), Some(real.as_path()));
        // 대화가 있는 파일이 더 최근이면 그것
        std::thread::sleep(std::time::Duration::from_millis(50));
        let newer = dir.join("newer.jsonl");
        std::fs::write(&newer, "{\"type\":\"assistant\",\"message\":{\"content\":[]}}\n").unwrap();
        assert_eq!(latest_session(&dir).as_deref(), Some(newer.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(latest_session(&dir), None);
    }

    /// 끝부분이 큰 도구 결과(파일 읽기·테스트 출력)로 채워져도 그 앞의 대화를 가져온다
    /// — 끝 1MB만 읽던 때는 "[Request interrupted by user]" 한 줄만 남아 대화가 사라진 것처럼 보였다.
    #[test]
    fn transcript_reaches_past_huge_tool_results() {
        let dir = std::env::temp_dir().join(format!("aith-claude-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let msg = |role: &str, text: &str| json!({ "type": role, "message": { "role": role, "content": text } }).to_string();
        let tool = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "content": "x".repeat(700_000) }] } }).to_string();
        let lines = [msg("user", "첫 질문"), msg("assistant", "첫 답"), msg("user", "둘째 질문"), tool.clone(), tool, msg("user", "[Request interrupted by user]")];
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        let (out, _) = transcript_at(&f, 20).unwrap();
        let texts: Vec<&str> = out.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["첫 질문", "첫 답", "둘째 질문", "[Request interrupted by user]"]);
        // limit만큼 모이면 더 거슬러 읽지 않는다(끝에서부터 최근 것만)
        let (out, _) = transcript_at(&f, 1).unwrap();
        assert_eq!(out.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 분배·팀 제안 단발 호출: 도구·MCP·사용자 설정 없이, 기록 안 남기고, 스키마대로 JSON
    #[test]
    fn oneshot_args_are_minimal() {
        let a = oneshot_args("haiku", "분배 담당", &json!({ "type": "object" }));
        let has = |x: &str| a.iter().any(|y| y == x);
        for must in ["-p", "--json-schema", "--strict-mcp-config", "--no-session-persistence", "--tools", "--setting-sources", "haiku", "분배 담당"] {
            assert!(has(must), "{must} 없음: {a:?}");
        }
        let i = a.iter().position(|x| x == "--tools").unwrap();
        assert_eq!(a[i + 1], "", "도구 없음");
        let j = a.iter().position(|x| x == "--output-format").unwrap();
        assert_eq!(a[j + 1], "json");
        // 생각을 줄여야 몇 초 안에 끝난다(실측: 기본 22초 → low 4.5초)
        let k = a.iter().position(|x| x == "--effort").expect("--effort 없음");
        assert_eq!(a[k + 1], "low");
    }

    /// 대화 고르기 목록: 최근 것부터, 대화 없는 기록은 빼고, 제목·첫 질문·마지막 말
    #[test]
    fn lists_sessions_newest_first_with_previews() {
        let dir = std::env::temp_dir().join(format!("aith-claude-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let msg = |role: &str, text: &str| json!({ "type": role, "message": { "role": role, "content": text } }).to_string();
        let title = json!({ "type": "ai-title", "aiTitle": "결제 화면 작업" }).to_string();
        std::fs::write(dir.join("old.jsonl"), [msg("user", "결제 화면 만들어줘"), title, msg("assistant", "만들었어요")].join("\n")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(dir.join("empty.jsonl"), "").unwrap();
        std::fs::write(dir.join("queue.jsonl"), "{\"type\":\"queue-operation\"}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let note = msg("user", "<task-notification>\n<task-id>x</task-id>\n</task-notification>");
        std::fs::write(dir.join("new.jsonl"), [note, msg("user", "브리핑해줘"), msg("assistant", "지금 3개 끝났어요")].join("\n")).unwrap();

        let list = sessions_in(&dir, 10);
        let ids: Vec<&str> = list.iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["new", "old"]);
        assert_eq!(list[0]["first"], "브리핑해줘");
        assert_eq!(list[0]["last"], "지금 3개 끝났어요");
        assert_eq!(list[1]["title"], "결제 화면 작업");
        assert!(list[0]["mtime"].as_u64().unwrap() > 0);
        assert_eq!(sessions_in(&dir, 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
