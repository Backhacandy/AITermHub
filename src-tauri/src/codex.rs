// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! Codex 구조화 세션: `codex exec --json`(JSONL)로 턴마다 one-shot 실행, thread_id로 resume.
//! stdout JSONL은 "codex-event"로 emit, 턴 종료 시 "codex-turn-done"(컨텍스트 사용량 포함).
//!
//! - 프롬프트는 명령줄이 아니라 stdin(`-`)으로 넘긴다. cmd.exe가 `& | % ^ "`를 해석해
//!   명령 주입·문자 깨짐(%PATH% 치환 등)이 생기는 것을 막는다.
//! - 승인/샌드박스는 `-c approval_policy=` / `-c sandbox_mode=`로 넘긴다. codex 0.16x의
//!   `exec`는 `-a`를, `exec resume`은 `-s`를 받지 않아 턴이 즉시 실패했었다.
//! - "이어서"는 `--last`(전역 최신) 대신 ~/.codex/sessions에서 이 폴더(cwd)의 최신 세션을
//!   찾아 그 id로 resume하고, 지난 대화도 화면에 복원한다.
//! - 모든 이벤트에 `turn` 번호를 붙여 늦게 도착한 이전 턴 이벤트를 프론트가 걸러낸다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

// ---- 세션 기록(~/.codex/sessions) ----

fn sessions_dir() -> PathBuf {
    let home = std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".codex")
    });
    home.join("sessions")
}

/// sessions/YYYY/MM/DD/*.jsonl 전부(최신 수정 순).
fn rollout_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: u32, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 4 {
                    walk(&p, depth + 1, out);
                }
            } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                out.push((t, p));
            }
        }
    }
    let mut v = Vec::new();
    walk(&sessions_dir(), 0, &mut v);
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, p)| p).collect()
}

fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// 사람이 직접 나눈 대화인지(검토기 "guardian_review"·하위 에이전트 "subagent" 세션이 아닌지).
/// codex가 자동 승인 검토나 서브에이전트용으로 만든 세션을 이어받으면, 모델이 그 역할
/// (예: {"outcome":"allow"}만 답하기)을 이어서 해 버린다.
fn is_user_thread(meta: &Value) -> bool {
    if let Some(ts) = meta.get("thread_source").and_then(|x| x.as_str()) {
        return ts == "user";
    }
    // 옛 버전: thread_source가 없으면 source가 subagent 객체인지로 판단
    !meta.get("source").map(|s| s.get("subagent").is_some()).unwrap_or(false)
}

fn meta_value(path: &Path) -> Option<Value> {
    let f = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(f).read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(&line).ok()?;
    Some(v.get("payload").cloned().unwrap_or(v))
}

/// rollout 첫 줄(session_meta)에서 (세션 id, cwd).
#[allow(dead_code)]
fn session_meta(path: &Path) -> Option<(String, String)> {
    let f = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(f).read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(&line).ok()?;
    let p = v.get("payload").unwrap_or(&v);
    let id = p.get("id").and_then(|x| x.as_str())?.to_string();
    let cwd = p.get("cwd").and_then(|x| x.as_str())?.to_string();
    Some((id, cwd))
}

/// 이 세션이 이어받은 이전 세션 id(새 버전 codex는 대화가 길어지면 새 세션 파일을 만들고
/// 이전 대화를 암호화된 압축본으로 넘긴다 — 읽을 수 있는 메시지는 부모 파일에 있다).
fn parent_of(path: &Path) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(f).read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(&line).ok()?;
    let p = v.get("payload").unwrap_or(&v);
    ["parent_thread_id", "forked_from_id"]
        .iter()
        .find_map(|k| p.get(*k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from))
}

/// 표시용 메시지를 부모 세션까지 거슬러 모은다(최대 depth단계, limit개).
/// 압축으로 끊긴 지점에는 {"role":"compact"} 표시를 끼운다.
fn collect_chain(path: &Path, limit: usize, resolve: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut cur = Some(path.to_path_buf());
    let mut depth = 0;
    while let Some(p) = cur.take() {
        // 끝이 큰 도구 출력으로 차 있으면 더 거슬러 읽는다(끝 1MB만 보면 대화가 사라진 것처럼 보임)
        let have = out.iter().filter(|m| m["role"] != "compact").count();
        let mut msgs = crate::util::tail_parse(&p, crate::claude::TAIL_MAX, parse_messages, |m: &Vec<Value>| {
            have + m.iter().filter(|x| x["role"] != "compact").count() >= limit
        })
        .unwrap_or_default();
        msgs.extend(out);
        out = msgs;
        let shown = out.iter().filter(|m| m["role"] != "compact").count();
        depth += 1;
        if shown >= limit || depth >= 6 {
            break;
        }
        cur = parent_of(&p).and_then(|id| resolve(&id));
    }
    // 맨 앞의 압축 표시는 의미 없음(그 이전을 못 가져온 경우)
    while out.first().map(|m| m["role"] == "compact").unwrap_or(false) {
        out.remove(0);
    }
    out
}

/// 이 폴더(cwd)에서 가장 최근에 쓴 Codex 세션 (id, 파일).
pub fn latest_session_for(cwd: &str) -> Option<(String, PathBuf)> {
    let want = norm_path(cwd);
    rollout_files().into_iter().take(500).find_map(|p| {
        let m = meta_value(&p)?;
        let c = m.get("cwd")?.as_str()?;
        if norm_path(c) != want || !is_user_thread(&m) {
            return None;
        }
        Some((m.get("id")?.as_str()?.to_string(), p))
    })
}

/// 세션 id로 rollout 파일 찾기(파일명이 `...-<id>.jsonl`).
pub(crate) fn session_file(id: &str) -> Option<PathBuf> {
    let suffix = format!("{id}.jsonl");
    rollout_files()
        .into_iter()
        .find(|p| p.file_name().map(|n| n.to_string_lossy().ends_with(&suffix)).unwrap_or(false))
}

/// Codex가 대화에 끼워 넣는 환경/지침 메시지인지(사용자가 쓴 말이 아님).
fn is_injected(text: &str) -> bool {
    let t = text.trim_start();
    (t.starts_with('<') && t.trim_end().ends_with('>')) || t.starts_with("# AGENTS.md")
}

/// rollout jsonl 텍스트에서 user/assistant 메시지 추출.
fn parse_messages(content: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(|x| x.as_str()) == Some("compaction") {
            out.push(json!({ "role": "compact", "text": "" }));
            continue;
        }
        if p.get("type").and_then(|x| x.as_str()) != Some("message") {
            continue;
        }
        let role = p.get("role").and_then(|x| x.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = p
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() || (role == "user" && is_injected(&text)) {
            continue;
        }
        out.push(json!({ "role": role, "text": text }));
    }
    out
}

/// 이 폴더의 Codex 대화 목록(사용자가 이어 갈 대화를 직접 고르는 용도). 최근 것부터 limit개.
pub fn sessions(cwd: &str, limit: usize) -> Value {
    json!(sessions_from(rollout_files().into_iter().take(500).collect(), cwd, limit))
}

fn sessions_from(files: Vec<PathBuf>, cwd: &str, limit: usize) -> Vec<Value> {
    let want = norm_path(cwd);
    let clip = |s: &str, n: usize| {
        let t = s.trim().replace(['\r', '\n'], " ");
        if t.chars().count() > n { format!("{}…", t.chars().take(n).collect::<String>()) } else { t }
    };
    let mut out = Vec::new();
    for p in files {
        if out.len() >= limit {
            break;
        }
        let Some(m) = meta_value(&p) else { continue };
        if m.get("cwd").and_then(|x| x.as_str()).map(norm_path) != Some(want.clone()) || !is_user_thread(&m) {
            continue;
        }
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else { continue };
        let first_msgs = parse_messages(&crate::util::read_head(&p, 1_000_000));
        let tail = crate::util::tail_parse(&p, 16_000_000, parse_messages, |v: &Vec<Value>| v.iter().any(|x| x["role"] != "compact")).unwrap_or_default();
        let Some(last) = tail.iter().rev().find(|x| x["role"] != "compact") else { continue };
        let first = first_msgs.iter().chain(tail.iter()).find(|x| x["role"] == "user").and_then(|x| x["text"].as_str()).unwrap_or("");
        let md = std::fs::metadata(&p).ok();
        let secs = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(json!({
            "id": id,
            "mtime": secs,
            "size": md.map(|m| m.len()).unwrap_or(0),
            "title": null,
            "first": clip(first, 300),
            "last": clip(last["text"].as_str().unwrap_or(""), 200),
        }));
    }
    out
}

/// 지난 Codex 대화 복원용. `thread`가 없으면 cwd의 최신 세션을 쓴다.
/// 반환: {"threadId": id 또는 null, "messages": [{role, text}]}
pub fn transcript(cwd: &str, thread: Option<&str>, limit: usize) -> Value {
    // 저장된 thread가 검토기·서브에이전트 세션이면 버리고 이 폴더의 사람 대화를 다시 찾는다
    let saved = thread
        .filter(|t| crate::util::safe_arg(t))
        .and_then(|t| session_file(t).map(|p| (t.to_string(), p)))
        .filter(|(_, p)| meta_value(p).map(|m| is_user_thread(&m)).unwrap_or(false));
    let found = saved.or_else(|| latest_session_for(cwd));
    let Some((id, path)) = found else {
        return json!({ "threadId": null, "messages": [] });
    };
    // 세션 파일은 수십 MB까지 커지므로 끝부분만 읽고, 압축으로 이어진 세션이면 부모까지 거슬러 모은다.
    let msgs = collect_chain(&path, limit, &|tid| session_file(tid));
    let start = msgs.len().saturating_sub(limit);
    json!({ "threadId": id, "messages": msgs[start..].to_vec() })
}

/// 세션 파일 끝부분의 token_count에서
/// - 컨텍스트: (현재 컨텍스트 입력 토큰, 컨텍스트 창 크기) — `cached_input_tokens`는 `input_tokens`에 포함돼 있어 더하지 않는다
/// - 사용 한도: rate_limits 원본(primary/secondary: used_percent, window_minutes, resets_at)
fn session_stats(path: &Path) -> (Option<(u64, u64)>, Option<Value>) {
    let Some(tail) = crate::util::read_tail(path, 300_000) else { return (None, None) };
    let mut ctx = None;
    let mut limits = None;
    for line in tail.lines().rev() {
        if ctx.is_some() && limits.is_some() {
            break;
        }
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = v.get("payload") else { continue };
        if limits.is_none() {
            if let Some(rl) = p.get("rate_limits").filter(|r| !r.is_null()) {
                limits = Some(rl.clone());
            }
        }
        // info가 null인 token_count(속도 제한 갱신만 있는 것)는 컨텍스트 계산에서 건너뛴다
        if ctx.is_none() {
            if let Some(info) = p.get("info").filter(|i| !i.is_null()) {
                if let Some(used) = info.pointer("/last_token_usage/input_tokens").and_then(|x| x.as_u64()) {
                    let window = info.get("model_context_window").and_then(|x| x.as_u64()).unwrap_or(0);
                    ctx = Some((used, window));
                }
            }
        }
    }
    (ctx, limits)
}

/// 가장 최근 Codex 세션 파일 기준의 사용 한도(앱을 열자마자 보여주기용).
pub fn latest_limits() -> Option<Value> {
    rollout_files().into_iter().take(5).find_map(|p| session_stats(&p).1)
}

// ---- 세션 매니저 ----

struct Running {
    child: Child,
    pid: u32,
    /// turn.completed/turn.failed를 받았는지. codex exec는 답변을 끝낸 뒤에도 프로세스가
    /// 한동안(수 분) 남아 있는 경우가 있어, 끝난 턴의 프로세스는 정리 대상으로 본다.
    completed: Arc<AtomicBool>,
}

/// 턴이 끝났는데도 이 시간 뒤까지 프로세스가 남아 있으면 정리한다.
const LINGER_KILL: std::time::Duration = std::time::Duration::from_secs(3);

fn kill_running(r: &mut Running) {
    crate::procctl::kill_tree(r.pid);
    let _ = r.child.kill();
    let _ = r.child.wait();
}

struct CSess {
    cwd: String,
    model: Option<String>,
    sandbox: String,
    approval: String,
    thread_id: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Option<Running>>>,
    /// 계정 풀: 이 세션의 기본 실행 환경(CODEX_HOME)
    env: Vec<(String, String)>,
}

#[derive(Default)]
pub struct CodexManager {
    sessions: Mutex<HashMap<String, CSess>>,
}

const SANDBOXES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];
const APPROVALS: &[&str] = &["untrusted", "on-failure", "on-request", "never"];

impl CodexManager {
    /// 세션 등록. `resume`이 있으면 첫 턴부터 그 thread를 이어간다.
    pub fn start(
        &self,
        id: String,
        cwd: String,
        model: Option<String>,
        sandbox: String,
        approval: String,
        resume: Option<String>,
        env: Vec<(String, String)>,
    ) -> Result<(), String> {
        crate::util::one_of(&sandbox, SANDBOXES)?;
        crate::util::one_of(&approval, APPROVALS)?;
        let model = model.filter(|m| !m.is_empty());
        if let Some(m) = &model {
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
        self.stop(&id);
        self.sessions.lock().unwrap().insert(
            id,
            CSess {
                cwd,
                model,
                sandbox,
                approval,
                thread_id: Arc::new(Mutex::new(resume)),
                child: Arc::new(Mutex::new(None)),
                env,
            },
        );
        Ok(())
    }

    /// 한 턴 실행. `turn`은 프론트가 정한 턴 번호로 이 턴의 모든 이벤트에 실린다
    /// (프론트가 미리 알고 있어야 invoke 응답보다 먼저 온 이벤트도 놓치지 않는다).
    /// `compact_limit`: 컨텍스트가 이 토큰 수를 넘으면 codex가 스스로 대화를 압축한다
    /// (model_auto_compact_token_limit — 프론트가 컨텍스트 창의 60%로 넘긴다).
    /// `model` / `env`가 있으면 이 턴만 그 모델·계정으로 실행한다(협업 탭 자동 모델, 계정 전환).
    pub fn send(
        &self,
        app: &AppHandle,
        id: &str,
        text: &str,
        turn: u64,
        compact_limit: Option<u64>,
        model: Option<String>,
        env: Option<Vec<(String, String)>>,
        effort: Option<String>,
    ) -> Result<(), String> {
        let model_override = model.filter(|m| !m.is_empty());
        if let Some(m) = &model_override {
            if !crate::util::safe_arg(m) {
                return Err(format!("모델 이름에 허용되지 않는 문자: {m}"));
            }
        }
        let (cwd, model, sandbox, approval, thread_id, child_slot, env) = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(id).ok_or("세션 없음")?;
            (
                s.cwd.clone(),
                model_override.or_else(|| s.model.clone()),
                s.sandbox.clone(),
                s.approval.clone(),
                s.thread_id.clone(),
                s.child.clone(),
                env.unwrap_or_else(|| s.env.clone()),
            )
        };

        // 이전 턴: 정말 진행 중이면 거부, 답변은 끝났는데 프로세스만 남아 있으면 정리하고 진행
        {
            let mut slot = child_slot.lock().unwrap();
            if let Some(r) = slot.as_mut() {
                if matches!(r.child.try_wait(), Ok(None)) {
                    if r.completed.load(Ordering::SeqCst) {
                        kill_running(r);
                    } else {
                        return Err("이전 턴이 아직 실행 중이에요".into());
                    }
                }
            }
            *slot = None;
        }

        let tid = thread_id.lock().unwrap().clone();

        let mut args: Vec<String> = vec!["/C".into(), "codex".into(), "exec".into()];
        if let Some(t) = &tid {
            args.push("resume".into());
            args.push(t.clone());
        }
        args.push("--json".into());
        args.push("--skip-git-repo-check".into());
        args.push("-c".into());
        args.push(format!("sandbox_mode={sandbox}"));
        args.push("-c".into());
        args.push(format!("approval_policy={approval}"));
        if let Some(m) = &model {
            args.push("-m".into());
            args.push(m.clone());
        }
        // 허브 안내(aith-open·화면 빼앗지 않기, TOML 여러 줄 리터럴 — 따옴표 이스케이프 불필요)
        args.push("-c".into());
        args.push(format!("developer_instructions='''{}'''", crate::tools::AGENT_HINT));
        if let Some(limit) = compact_limit.filter(|l| *l > 0) {
            args.push("-c".into());
            args.push(format!("model_auto_compact_token_limit={limit}"));
        }
        // 생각 깊이: 고르지 않으면 config.toml(model_reasoning_effort)을 따른다
        if let Some(e) = crate::util::pick_effort(effort.as_deref(), crate::util::CODEX_EFFORTS) {
            args.push("-c".into());
            args.push(format!("model_reasoning_effort={e}"));
        }
        // 프롬프트는 stdin으로
        args.push("-".into());

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
        for (k, v) in &env {
            cmd.env(k, v);
        }
        // 에이전트마다 임시 폴더 — 쓰고 버린 브라우저 프로필·빌드 임시 파일을 앱이 나중에 치울 수 있게(storage.rs)
        if let Some(t) = crate::storage::agent_tmp(id) {
            cmd.env("TEMP", &t).env("TMP", &t);
        }

        let mut child = cmd.spawn().map_err(|e| format!("codex 실행 실패: {e}"))?;
        let pid = child.id();
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
            // drop으로 stdin을 닫아야 codex가 입력 끝을 안다
        }
        let stdout = child.stdout.take().ok_or("stdout 없음")?;
        let stderr = child.stderr.take();

        let completed = Arc::new(AtomicBool::new(false));
        let app2 = app.clone();
        let id2 = id.to_string();
        let tid_store = thread_id.clone();
        let done_flag = completed.clone();
        let slot2 = child_slot.clone();
        std::thread::spawn(move || {
            // 턴 종료 알림: 세션 파일에서 정확한 컨텍스트 사용량을 읽어 함께 보낸다(한 번만).
            let mut notified = false;
            let notify_done = |notified: &mut bool| {
                if *notified {
                    return;
                }
                *notified = true;
                let tid = tid_store.lock().unwrap().clone();
                let (ctx, limits) = tid
                    .as_deref()
                    .and_then(session_file)
                    .map(|p| session_stats(&p))
                    .unwrap_or((None, None));
                let _ = app2.emit(
                    "codex-turn-done",
                    json!({
                        "id": id2,
                        "turn": turn,
                        "threadId": tid,
                        "ctx": ctx.map(|(used, window)| json!({ "used": used, "window": window })),
                        "limits": limits,
                    }),
                );
            };
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let l = line.trim().to_string();
                if l.is_empty() {
                    continue;
                }
                let kind = serde_json::from_str::<Value>(&l)
                    .ok()
                    .map(|v| (v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string(), v));
                // thread.started에서 thread_id 포착(다음 턴 resume용)
                if let Some((t, v)) = &kind {
                    if t == "thread.started" {
                        if let Some(tid) = v.get("thread_id").and_then(|t| t.as_str()) {
                            *tid_store.lock().unwrap() = Some(tid.to_string());
                        }
                    }
                }
                let _ = app2.emit("codex-event", json!({ "id": id2, "turn": turn, "line": l }));
                // 답변이 끝났으면 프로세스 종료를 기다리지 않고 바로 턴 종료로 처리,
                // 잠시 뒤에도 프로세스가 남아 있으면 정리한다.
                if matches!(kind.as_ref().map(|(t, _)| t.as_str()), Some("turn.completed" | "turn.failed")) {
                    done_flag.store(true, Ordering::SeqCst);
                    notify_done(&mut notified);
                    let slot = slot2.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(LINGER_KILL);
                        if let Some(r) = slot.lock().unwrap().as_mut() {
                            if r.pid == pid && matches!(r.child.try_wait(), Ok(None)) {
                                kill_running(r);
                            }
                        }
                    });
                }
            }
            notify_done(&mut notified);
        });

        if let Some(serr) = stderr {
            let app3 = app.clone();
            let id3 = id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(serr);
                for line in reader.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        let _ = app3.emit("codex-stderr", json!({ "id": id3, "turn": turn, "line": line }));
                    }
                }
            });
        }

        *child_slot.lock().unwrap() = Some(Running { child, pid, completed });
        Ok(())
    }

    /// 실행 중인 턴만 중단(세션은 유지).
    pub fn cancel(&self, id: &str) {
        let slot = self.sessions.lock().unwrap().get(id).map(|s| s.child.clone());
        if let Some(slot) = slot {
            if let Some(mut r) = slot.lock().unwrap().take() {
                kill_running(&mut r);
            }
        }
    }

    pub fn stop(&self, id: &str) {
        self.cancel(id);
        self.sessions.lock().unwrap().remove(id);
    }

    /// 지금 턴이 돌고 있는 세션 수(앱 종료 확인용).
    pub fn running_count(&self) -> usize {
        let slots: Vec<_> = self.sessions.lock().unwrap().values().map(|s| s.child.clone()).collect();
        slots
            .iter()
            .filter(|slot| {
                slot.lock()
                    .unwrap()
                    .as_mut()
                    .map(|r| !r.completed.load(Ordering::SeqCst) && matches!(r.child.try_wait(), Ok(None)))
                    .unwrap_or(false)
            })
            .count()
    }

    /// 세션별 메모리(세션 상태 패널용). 턴 사이에는 프로세스가 없으므로 0 MB · 대기.
    pub fn stats(&self) -> Vec<crate::pty::SessionStat> {
        let slots: Vec<(String, Arc<Mutex<Option<Running>>>)> =
            self.sessions.lock().unwrap().iter().map(|(id, s)| (id.clone(), s.child.clone())).collect();
        slots
            .into_iter()
            .map(|(id, slot)| {
                let live = slot.lock().unwrap().as_mut().and_then(|r| {
                    let alive = matches!(r.child.try_wait(), Ok(None)) && !r.completed.load(Ordering::SeqCst);
                    alive.then_some(r.pid)
                });
                match live {
                    Some(pid) => crate::pty::SessionStat {
                        rss: crate::procctl::working_set_bytes(pid),
                        id,
                        pid,
                        suspended: false,
                        pinned: false,
                        note: None,
                    },
                    None => crate::pty::SessionStat {
                        rss: 0,
                        id,
                        pid: 0,
                        suspended: false,
                        pinned: false,
                        note: Some("대기".into()),
                    },
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 대화 고르기 목록: 이 폴더의 사람 대화만(검토기·다른 폴더 제외), 첫 질문·마지막 말
    #[test]
    fn lists_this_folders_user_threads() {
        let dir = std::env::temp_dir().join(format!("aith-codex-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let msg = |role: &str, text: &str| format!(r#"{{"type":"response_item","payload":{{"type":"message","role":"{role}","content":[{{"type":"input_text","text":"{text}"}}]}}}}"#);
        let file = |name: &str, meta: &str, lines: &[String]| {
            let p = dir.join(name);
            std::fs::write(&p, format!("{meta}\n{}", lines.join("\n"))).unwrap();
            p
        };
        let a = file("a.jsonl", r#"{"type":"session_meta","payload":{"id":"A","cwd":"C:\\p","thread_source":"user"}}"#, &[msg("user", "API 추가해줘"), msg("assistant", "추가했어요")]);
        let g = file("g.jsonl", r#"{"type":"session_meta","payload":{"id":"G","cwd":"C:\\p","thread_source":"guardian_review"}}"#, &[msg("user", "검토")]);
        let o = file("o.jsonl", r#"{"type":"session_meta","payload":{"id":"O","cwd":"C:\\other","thread_source":"user"}}"#, &[msg("user", "다른 폴더")]);
        let list = sessions_from(vec![g, o, a], "c:/p/", 10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "A");
        assert_eq!(list[0]["first"], "API 추가해줘");
        assert_eq!(list[0]["last"], "추가했어요");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_rollout_messages_and_skips_injected() {
        let jsonl = [
            r#"{"type":"session_meta","payload":{"id":"abc","cwd":"C:\\p"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>C:\\p</cwd>\n</environment_context>"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"안녕"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"네, 안녕하세요"}]}}"#,
        ]
        .join("\n");
        let m = parse_messages(&jsonl);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["role"], "user");
        assert_eq!(m[0]["text"], "안녕");
        assert_eq!(m[1]["role"], "assistant");
    }

    #[test]
    fn session_stats_reads_context_and_limits() {
        let dir = std::env::temp_dir().join(format!("aith-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout.jsonl");
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\p"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":19225},"model_context_window":258400},"rate_limits":null}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":2},"secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":3}}}}"#,
        ];
        std::fs::write(&f, lines.join("
")).unwrap();
        let (ctx, limits) = session_stats(&f);
        assert_eq!(ctx, Some((19225, 258400)));
        let l = limits.unwrap();
        assert_eq!(l["primary"]["used_percent"], 12.5);
        assert_eq!(l["secondary"]["window_minutes"], 10080);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn follows_parent_thread_across_compaction() {
        let dir = std::env::temp_dir().join(format!("aith-chain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let parent = dir.join("parent.jsonl");
        let child = dir.join("child.jsonl");
        std::fs::write(&parent, [
            r#"{"type":"session_meta","payload":{"id":"P","cwd":"C:/p"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"로그인 만들어줘"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"만들었어요"}]}}"#,
        ].join("\n")).unwrap();
        std::fs::write(&child, [
            r#"{"type":"session_meta","payload":{"id":"C","cwd":"C:/p","parent_thread_id":"P"}}"#,
            r#"{"type":"response_item","payload":{"type":"compaction","encrypted_content":"x"}}"#,
        ].join("\n")).unwrap();
        let (pp, cc) = (parent.clone(), child.clone());
        let msgs = collect_chain(&cc, 20, &|id| (id == "P").then(|| pp.clone()));
        let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "assistant", "compact"]);
        assert_eq!(msgs[0]["text"], "로그인 만들어줘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_guardian_and_subagent_threads() {
        let user = json!({ "id": "u", "thread_source": "user", "source": "cli" });
        let guardian = json!({ "id": "g", "thread_source": "guardian_review", "source": { "subagent": { "other": "guardian" } } });
        let sub = json!({ "id": "s", "thread_source": "subagent", "source": { "subagent": { "thread_spawn": {} } } });
        let old = json!({ "id": "o", "source": "cli" });
        let old_sub = json!({ "id": "os", "source": { "subagent": {} } });
        assert!(is_user_thread(&user));
        assert!(!is_user_thread(&guardian));
        assert!(!is_user_thread(&sub));
        assert!(is_user_thread(&old));
        assert!(!is_user_thread(&old_sub));
    }

    #[test]
    fn norm_path_ignores_case_and_slashes() {
        assert_eq!(norm_path("C:/AITermHub/"), norm_path(r"c:\aitermhub"));
    }
}

/// Codex가 받아 둔 모델 목록(models_cache.json)에서 보여 줄 모델만: [{slug, label, priority}] (priority 작을수록 추천)
/// 앱 안 목록을 코드에 적어 두면 새 모델(예: GPT-6.2)이 나와도 안 보였다 — Codex가 아는 목록을 그대로 따른다
pub fn models_from(text: &str) -> Vec<Value> {
    let v: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let mut out: Vec<Value> = v
        .get("models")
        .and_then(|m| m.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|m| m.get("visibility").and_then(|x| x.as_str()) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?;
            if !crate::util::safe_arg(slug) {
                return None;
            }
            let label = m.get("display_name").and_then(|x| x.as_str()).unwrap_or(slug);
            let priority = m.get("priority").and_then(|x| x.as_i64()).unwrap_or(999);
            Some(serde_json::json!({ "slug": slug, "label": label, "priority": priority }))
        })
        .collect();
    out.sort_by_key(|m| m.get("priority").and_then(|x| x.as_i64()).unwrap_or(999));
    out
}

#[tauri::command(async)]
pub fn codex_models() -> Vec<Value> {
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".codex"));
    std::fs::read_to_string(home.join("models_cache.json")).map(|t| models_from(&t)).unwrap_or_default()
}

#[cfg(test)]
mod models_tests {
    #[test]
    fn lists_visible_models_in_recommended_order() {
        let text = r#"{"fetched_at":"x","models":[
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":6},
            {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":4},
            {"slug":"gpt-6.2-sol","display_name":"GPT-6.2-Sol","visibility":"list","priority":1},
            {"slug":"bad name","display_name":"x","visibility":"list","priority":2}]}"#;
        let v = super::models_from(text);
        let slugs: Vec<&str> = v.iter().map(|m| m["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, vec!["gpt-6.2-sol", "gpt-6-astra"]);
        assert_eq!(v[0]["label"], "GPT-6.2-Sol");
        assert!(super::models_from("깨진 파일").is_empty());
    }
}
