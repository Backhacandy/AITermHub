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
    /// 마지막으로 맞춘 크기(cols, rows) — 같은 크기면 다시 맞추지 않는다
    size: (u16, u16),
    /// 직전 모니터 틱에서 CPU를 많이 썼는지(두 번 연속이어야 일하는 중으로 친다)
    cpu_busy: bool,
}

/// 이번 틱의 CPU 사용(delta ms) → (이번 틱 바쁨, 활동으로 칠지). 쉬는 CLI도 가끔 한 틱만 CPU를 튀기므로 두 틱 연속일 때만 활동
pub(crate) fn cpu_busy_tick(prev_busy: bool, delta: u64) -> (bool, bool) {
    let busy = delta >= CPU_ACTIVE_MS;
    (busy, busy && prev_busy)
}

/// 같은 크기로 다시 맞추면 ConPTY가 화면 전체를 다시 그려 "출력"이 생기고, 쉬는 세션이 잠들지 못한다(화면 배치가 조금만 흔들려도 매번)
pub(crate) fn size_changed(last: Option<(u16, u16)>, new: (u16, u16)) -> bool {
    last != Some(new)
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
                size: (cols, rows),
                cpu_busy: false,
            },
        );
        Ok(pid)
    }

    /// 세션 stdin에 쓰기. 정지된 세션이면 먼저 깨운다(포커스 신호만 온 것은 보기만 한 것이라 깨우지 않고 버린다).
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        if is_focus_only(data) && self.sessions.lock().unwrap().get(id).map(|s| s.suspended).unwrap_or(false) {
            return Ok(());
        }
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
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            if !size_changed(Some(s.size), (cols, rows)) {
                return Ok(());
            }
            s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            s.size = (cols, rows);
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
                    if s.last_cpu_ms != 0 {
                        let (busy, active) = cpu_busy_tick(s.cpu_busy, cpu.saturating_sub(s.last_cpu_ms));
                        s.cpu_busy = busy;
                        if active {
                            s.last_output.store(now_ms(), Ordering::Relaxed);
                        }
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

/// 터미널 포커스 신호(ESC [ I / ESC [ O)로만 이뤄진 입력인지 — 탭을 누르거나 창을 오갈 때 xterm이 보낸다
pub(crate) fn is_focus_only(data: &[u8]) -> bool {
    !data.is_empty() && data.len() % 3 == 0 && data.chunks(3).all(|c| c == b"\x1b[I" || c == b"\x1b[O")
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

#[cfg(test)]
mod idle_probe {
    /// 쉬는 claude가 화면에 뭘 언제 쓰는지 기록(수동): cargo test --lib idle_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_idle_output() {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Read;
        let dir = std::env::var("AITH_PROBE_DIR").unwrap_or_else(|_| r"C:\Demo\game".into());
        let secs: u64 = std::env::var("AITH_PROBE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(180);
        let pair = native_pty_system().openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
        let extra = std::env::var("AITH_PROBE_ARGS").unwrap_or_default();
        let mut a: Vec<String> = vec!["/k".into(), "claude".into()];
        a.extend(extra.split_whitespace().map(String::from));
        let cmd = super::tab_command("cmd.exe", &a, &Some(dir), &[]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        let mut r = pair.master.try_clone_reader().unwrap();
        let _w = pair.master.take_writer().unwrap();
        let start = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel::<(u128, Vec<u8>)>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 { break; }
                let _ = tx.send((start.elapsed().as_millis(), buf[..n].to_vec()));
            }
        });
        let mut resized = 0;
        while start.elapsed().as_secs() < secs {
            // 조용해진 뒤 같은 크기로 다시 맞추기(앱의 ResizeObserver가 하는 일)
            if std::env::var("AITH_PROBE_RESIZE").is_ok() && resized < 3 && start.elapsed().as_secs() >= 30 + resized * 15 {
                resized += 1;
                println!("--- 같은 크기로 resize #{resized}");
                let _ = pair.master.resize(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 });
            }
            if let Ok((t, b)) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
                if t > 20_000 {
                    let s: String = String::from_utf8_lossy(&b).chars().map(|c| if c.is_control() { '.' } else { c }).take(160).collect();
                    println!("{:>7}ms {:>5}B {}", t, b.len(), s);
                }
            }
        }
        let _ = child.kill();
    }
}

#[cfg(test)]
mod resize_tests {
    use super::size_changed;

    /// 같은 크기로 다시 맞추면 ConPTY가 화면 전체를 다시 그려(약 1.4KB) "출력"이 되고, 쉬는 세션이 영영 잠들지 못한다
    #[test]
    fn same_size_is_not_a_change() {
        assert!(size_changed(None, (120, 40)), "처음은 맞춘다");
        assert!(!size_changed(Some((120, 40)), (120, 40)), "같은 크기는 건너뛴다");
        assert!(size_changed(Some((120, 40)), (121, 40)));
        assert!(size_changed(Some((120, 40)), (120, 41)));
    }
}

#[cfg(test)]
mod cpu_tests {
    use super::{cpu_busy_tick, CPU_ACTIVE_MS};

    /// 쉬는 Claude는 1~2분마다 3초 구간에 CPU를 110~160ms 튀긴다 — 한 번 튄 것은 일로 치지 않는다(안 그러면 영영 못 잔다)
    #[test]
    fn single_burst_is_not_work() {
        let (busy, active) = cpu_busy_tick(false, CPU_ACTIVE_MS + 10);
        assert!(busy && !active, "한 번 튀면 표시만 하고 활동으로 치지 않는다");
        let (busy, active) = cpu_busy_tick(busy, 5);
        assert!(!busy && !active, "다음 틱에 조용하면 끝");
    }

    /// 빌드처럼 계속 CPU를 쓰면 두 번째 틱부터 일하는 중
    #[test]
    fn sustained_cpu_is_work() {
        let (b1, a1) = cpu_busy_tick(false, 900);
        let (b2, a2) = cpu_busy_tick(b1, 900);
        assert!(b1 && !a1);
        assert!(b2 && a2);
    }
}

#[cfg(test)]
mod focus_tests {
    use super::is_focus_only;

    /// 탭을 누르거나 창을 오가면 터미널이 포커스 신호를 보낸다 — 보기만 한 것이니 잠든 세션을 깨우지 않는다
    #[test]
    fn focus_reports_only() {
        assert!(is_focus_only(b"\x1b[I"));
        assert!(is_focus_only(b"\x1b[O"));
        assert!(is_focus_only(b"\x1b[O\x1b[I"));
        assert!(!is_focus_only(b""), "빈 입력은 해당 없음");
        assert!(!is_focus_only(b"a"));
        assert!(!is_focus_only(b"\x1b[Ia"), "실제 입력이 섞이면 깨운다");
        assert!(!is_focus_only(b"\r"));
    }
}
