// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! ConPTY 세션 관리: 자식 프로세스를 의사 콘솔로 실행하고 입출력을 중계한다.
//! 세션별 메모리 상태(정지/고정)와 마지막 출력 시각(유휴 판정용)도 관리한다.
//!
//! 출력은 세션별 "pty-output-<id>"({data(base64)}) 이벤트로 보내 해당 탭만 받게 하고,
//! 종료는 "pty-exit"({id}) 이벤트로 알린다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 하나의 PTY 세션.
struct Session {
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    suspended: bool,
    pinned: bool,
    /// 마지막 활동 시각(출력 또는 CPU 사용). 유휴 판정 기준.
    last_output: Arc<AtomicU64>,
    /// 직전 모니터 틱에서 본 트리 누적 CPU 시간(ms).
    last_cpu_ms: u64,
}

/// 모니터 주기(3초) 동안 이만큼 이상 CPU를 쓰면 "작업 중"으로 본다.
const CPU_ACTIVE_MS: u64 = 150;

/// 모니터/프론트로 보내는 세션 상태.
#[derive(Serialize, Clone)]
pub struct SessionStat {
    pub id: String,
    pub pid: u32,
    pub suspended: bool,
    pub pinned: bool,
    pub rss: u64,
    /// 화면에 메모리 옆에 붙일 상태(예: Codex 턴 사이 "대기")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 모든 세션을 id로 보관하는 매니저(Tauri 상태로 등록).
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    /// 새 세션 생성. 출력 중계 스레드를 띄우고 PID를 반환한다.
    pub fn spawn(
        &self,
        app: &AppHandle,
        id: String,
        program: String,
        args: Vec<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env: Vec<(String, String)>,
    ) -> Result<u32> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let cmd = tab_command(&program, &args, &cwd, &env);

        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let last_output = Arc::new(AtomicU64::new(now_ms()));

        // 출력 중계 스레드
        let app2 = app.clone();
        let id2 = id.clone();
        let out_event = format!("pty-output-{id}");
        let last2 = last_output.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        last2.store(now_ms(), Ordering::Relaxed);
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app2.emit(&out_event, serde_json::json!({ "data": b64 }));
                    }
                    Err(_) => break,
                }
            }
            let _ = app2.emit("pty-exit", serde_json::json!({ "id": id2 }));
        });

        self.sessions.lock().unwrap().insert(
            id,
            Session {
                pid,
                master: pair.master,
                writer,
                child,
                suspended: false,
                pinned: false,
                last_output,
                last_cpu_ms: 0,
            },
        );
        Ok(pid)
    }

    /// 세션 stdin에 쓰기. 정지된 세션이면 먼저 깨운다.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        // 정지 상태면 재개(syscall은 락 밖에서)
        let resume_pid = {
            let mut map = self.sessions.lock().unwrap();
            match map.get_mut(id) {
                Some(s) if s.suspended => {
                    s.suspended = false;
                    Some(s.pid)
                }
                _ => None,
            }
        };
        if let Some(pid) = resume_pid {
            let _ = crate::procctl::resume(pid);
        }
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            s.writer.write_all(data)?;
            s.writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let map = self.sessions.lock().unwrap();
        if let Some(s) = map.get(id) {
            s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        // 맵에서 빼낸 뒤 락을 놓고 syscall 수행
        let removed = self.sessions.lock().unwrap().remove(id);
        if let Some(mut s) = removed {
            // 정지된 채 죽이면 안 되므로 먼저 재개 시도
            if s.suspended {
                let _ = crate::procctl::resume(s.pid);
            }
            // cmd → node 등 자손까지 종료
            crate::procctl::kill_tree(s.pid);
            let _ = s.child.kill();
        }
        Ok(())
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions.lock().unwrap().get(id).map(|s| s.pid)
    }

    /// 가벼운 메모리 정리(계속 실행).
    pub fn trim(&self, id: &str) -> Result<()> {
        let pid = self.pid(id).ok_or_else(|| anyhow!("세션 없음: {id}"))?;
        crate::procctl::trim(pid)
    }

    /// 깊게 재우기(정지 + 메모리 반납).
    pub fn sleep(&self, id: &str) -> Result<()> {
        let pid = self.pid(id).ok_or_else(|| anyhow!("세션 없음: {id}"))?;
        crate::procctl::suspend(pid)?;
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.suspended = true;
        }
        Ok(())
    }

    /// 깨우기(재개).
    pub fn wake(&self, id: &str) -> Result<()> {
        let pid = self.pid(id).ok_or_else(|| anyhow!("세션 없음: {id}"))?;
        crate::procctl::resume(pid)?;
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.suspended = false;
        }
        Ok(())
    }

    /// "항상 깨어있음" 고정 설정.
    pub fn set_pinned(&self, id: &str, pinned: bool) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.pinned = pinned;
        }
    }

    /// 모든 세션 상태(RAM 포함). 모니터 틱마다 호출되며, CPU 사용량이 있으면
    /// 출력이 없어도 활동 중으로 갱신한다(출력 없는 긴 빌드가 자동 재우기로 멈추지 않게).
    pub fn stats(&self) -> Vec<SessionStat> {
        let base: Vec<(String, u32, bool, bool)> = {
            let map = self.sessions.lock().unwrap();
            map.iter()
                .map(|(id, s)| (id.clone(), s.pid, s.suspended, s.pinned))
                .collect()
        };
        let mut out = Vec::with_capacity(base.len());
        for (id, pid, suspended, pinned) in base {
            if !suspended {
                let cpu = crate::procctl::cpu_time_ms(pid);
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) {
                    if s.last_cpu_ms != 0 && cpu.saturating_sub(s.last_cpu_ms) >= CPU_ACTIVE_MS {
                        s.last_output.store(now_ms(), Ordering::Relaxed);
                    }
                    s.last_cpu_ms = cpu;
                }
            }
            out.push(SessionStat {
                rss: crate::procctl::working_set_bytes(pid),
                id,
                pid,
                suspended,
                pinned,
                note: None,
            });
        }
        out
    }

    /// 유휴(idle_ms 초과) + 미고정 + 미정지 세션을 자동으로 재운다. 새로 잠든 id 목록 반환.
    pub fn auto_sleep_idle(&self, idle_ms: u64) -> Vec<String> {
        let now = now_ms();
        let candidates: Vec<(String, u32)> = {
            let map = self.sessions.lock().unwrap();
            map.iter()
                .filter(|(_, s)| {
                    !s.suspended
                        && !s.pinned
                        && now.saturating_sub(s.last_output.load(Ordering::Relaxed)) >= idle_ms
                })
                .map(|(id, s)| (id.clone(), s.pid))
                .collect()
        };
        let mut slept = Vec::new();
        for (id, pid) in candidates {
            if crate::procctl::suspend(pid).is_ok() {
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) {
                    s.suspended = true;
                }
                slept.push(id);
            }
        }
        slept
    }

    /// 실행 중 세션 개수(앱 종료 확인용).
    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// 모든 세션 종료(앱 종료 시).
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

#[cfg(test)]
mod spawn_tests {
    use portable_pty::{native_pty_system, PtySize};

    fn try_spawn(no_cwd: bool) -> Result<(), String> {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
        let _ = no_cwd;
        let cmd = super::tab_command("cmd.exe", &["/c".into(), "exit".into(), "0".into()], &Some(std::env::temp_dir().to_string_lossy().into_owned()), &[]);
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let _ = child.kill();
        Ok(())
    }

    /// 탭은 cmd.exe로 띄운다 — 작업 폴더 막기 설정을 켜도 cmd.exe는 찾아서 떠야 한다
    #[test]
    fn spawns_cmd_with_and_without_guard() {
        assert_eq!(try_spawn(false), Ok(()));
        assert_eq!(try_spawn(true), Ok(()));
    }
}

#[cfg(test)]
mod path_tests {
    use super::merge_path;

    /// 레지스트리 PATH가 REG_SZ로 바뀌어 %SystemRoot%가 펼쳐지지 않은 PC: 앱의 PATH(펼쳐진 것)를 앞에, 레지스트리 항목은 펼쳐서 없는 것만 뒤에
    #[test]
    fn keeps_process_path_and_expands_registry() {
        std::env::set_var("AITH_TEST_ROOT", r"C:\Win");
        let merged = merge_path(r"C:\bin;C:\Win\system32", r"%AITH_TEST_ROOT%\system32;%AITH_TEST_ROOT%\new;C:\other");
        assert_eq!(merged, r"C:\bin;C:\Win\system32;C:\Win\new;C:\other");
    }

    #[test]
    fn case_and_trailing_slash_are_same_entry() {
        let merged = merge_path(r"C:\Tools\", r"c:\tools;C:\x");
        assert_eq!(merged, r"C:\Tools\;C:\x");
    }
}

/// 탭 프로세스 명령(spawn과 테스트가 같이 쓴다)
pub(crate) fn tab_command(program: &str, args: &[String], cwd: &Option<String>, env: &[(String, String)]) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // 부모(개발 세션)에서 상속된 Claude Code 마커 제거 → 탭의 claude가 독립 세션으로 동작
    for key in [
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SSE_PORT",
    ] {
        cmd.env_remove(key);
    }
    // cmd.exe가 명령 이름(claude·gemini 등)을 찾을 때 작업 폴더를 먼저 보지 않게 한다 —
    // 받은 저장소에 같은 이름의 .cmd/.bat이 있으면 진짜 CLI 대신 실행되는 것을 막는다(PATH에서만 찾음)
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    // portable-pty는 PATH를 레지스트리 값으로 다시 만든다. 시스템 PATH가 REG_SZ인 PC에서는 %SystemRoot%가 펼쳐지지 않아
    // cmd.exe조차 못 찾고(탭 시작 실패), 앱이 맨 앞에 넣은 도구 폴더(bin)도 빠진다 → 앱의 PATH를 앞에 두고 레지스트리 항목은 펼쳐서 뒤에
    let reg_path = cmd.get_env("PATH").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    cmd.env("PATH", merge_path(&std::env::var("PATH").unwrap_or_default(), &reg_path));
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

/// %이름% 을 이 프로세스의 환경 변수로 펼친다(없는 이름은 그대로)
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find('%') {
        let after = &rest[a + 1..];
        match after.find('%') {
            Some(b) => {
                let name = &after[..b];
                match std::env::var(name) {
                    Ok(v) if !name.is_empty() => {
                        out.push_str(&rest[..a]);
                        out.push_str(&v);
                    }
                    _ => out.push_str(&rest[..a + 1 + b + 1]),
                }
                rest = &after[b + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// 탭에 줄 PATH: 앱의 PATH(이미 펼쳐짐) 다음에 레지스트리 PATH 항목 중 없는 것(펼쳐서). 대소문자·끝의 \ 는 같은 것으로 본다
pub(crate) fn merge_path(process: &str, registry: &str) -> String {
    let norm = |p: &str| p.trim().trim_end_matches(['\\', '/']).to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for p in process.split(';').map(str::to_string).chain(registry.split(';').map(expand_vars)) {
        if p.trim().is_empty() {
            continue;
        }
        if seen.insert(norm(&p)) {
            out.push(p);
        }
    }
    out.join(";")
}
