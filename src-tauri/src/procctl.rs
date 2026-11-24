// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 프로세스 메모리 제어(Win32): 트리 단위 Trim / Suspend / Resume / 메모리 조회.
//!
//! AI CLI는 cmd.exe 로 감싸 실행하므로(cmd → node 등) 자손 프로세스까지 포함한
//! "트리" 전체에 적용한다.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use windows::core::{s, PCSTR};
use windows::Win32::Foundation::{CloseHandle, FALSE, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows::Win32::System::ProcessStatus::{
    EmptyWorkingSet, GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_ACCESS_RIGHTS,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_SUSPEND_RESUME, PROCESS_VM_READ,
};

/// ntdll의 NtSuspendProcess / NtResumeProcess 시그니처.
type NtProcFn = unsafe extern "system" fn(HANDLE) -> i32;

/// ntdll에서 함수 포인터를 동적으로 가져온다(공개 바인딩이 없는 비공식 API).
fn ntdll_fn(name: PCSTR) -> Option<NtProcFn> {
    unsafe {
        let module = GetModuleHandleA(s!("ntdll.dll")).ok()?;
        let proc = GetProcAddress(module, name)?;
        Some(std::mem::transmute::<_, NtProcFn>(proc))
    }
}

/// 프로세스 스냅샷을 뜬 횟수(테스트에서 한 바퀴에 몇 번 떴는지 본다)
static SNAPSHOTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 부모 PID → 자식 PID들(스냅샷 한 장)
fn take_children() -> Option<HashMap<u32, Vec<u32>>> {
    SNAPSHOTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        if Process32First(snap, &mut entry).is_ok() {
            loop {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    Some(children)
}

/// 한 바퀴 동안 함께 쓰는 스냅샷과 생성 시각(같은 PID를 여러 번 열지 않게)
struct Round {
    children: Option<HashMap<u32, Vec<u32>>>,
    ctime: HashMap<u32, Option<u64>>,
}

thread_local! {
    static ROUND: std::cell::RefCell<Option<Round>> = const { std::cell::RefCell::new(None) };
}

/// f 안에서 부르는 트리 조회(메모리·CPU 시간 등)는 스냅샷 한 장을 함께 쓴다.
/// 모니터가 3초마다 탭·에이전트 수십 개를 조회하며 매번 스냅샷을 새로 떠서 코어의 13%를 쓰던 것.
pub fn one_snapshot<R>(f: impl FnOnce() -> R) -> R {
    let outer = ROUND.with(|r| r.borrow().is_some());
    if !outer {
        ROUND.with(|r| *r.borrow_mut() = Some(Round { children: take_children(), ctime: HashMap::new() }));
    }
    let out = f();
    if !outer {
        ROUND.with(|r| *r.borrow_mut() = None);
    }
    out
}

/// root를 포함한 모든 자손 PID(BFS).
fn process_tree(root: u32) -> Vec<u32> {
    let shared = ROUND.with(|r| r.borrow().is_some());
    let own = if shared { None } else { take_children() };
    let ctime = |pid: u32| -> Option<u64> {
        if !shared {
            return creation_time(pid);
        }
        if let Some(v) = ROUND.with(|r| r.borrow().as_ref().and_then(|x| x.ctime.get(&pid).copied())) {
            return v;
        }
        let v = creation_time(pid);
        ROUND.with(|r| {
            if let Some(x) = r.borrow_mut().as_mut() {
                x.ctime.insert(pid, v);
            }
        });
        v
    };
    let kids_of = |pid: u32| -> Vec<u32> {
        if shared {
            ROUND.with(|r| r.borrow().as_ref().and_then(|x| x.children.as_ref()).and_then(|c| c.get(&pid).cloned()).unwrap_or_default())
        } else {
            own.as_ref().and_then(|c| c.get(&pid).cloned()).unwrap_or_default()
        }
    };
    if !shared && own.is_none() {
        return vec![root];
    }

    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        let cur = out[i];
        let kids = kids_of(cur);
        if !kids.is_empty() {
            let parent_start = ctime(cur);
            for k in kids {
                if k == cur || out.contains(&k) {
                    continue;
                }
                // PID 재사용 방어: 부모보다 먼저 생긴 프로세스는 진짜 자식이 아니다
                // (원래 부모가 죽고 같은 PID가 재사용된 경우).
                if let (Some(p), Some(c)) = (parent_start, ctime(k)) {
                    if c < p {
                        continue;
                    }
                }
                out.push(k);
            }
        }
        i += 1;
    }
    out
}

fn filetime_u64(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

/// (생성 시각, 커널+유저 CPU 시간) — 100ns 단위.
fn process_times(pid: u32) -> Option<(u64, u64)> {
    let mut out = None;
    let _ = with_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION, |h| unsafe {
        let (mut c, mut e, mut k, mut u) = Default::default();
        if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok() {
            out = Some((filetime_u64(c), filetime_u64(k) + filetime_u64(u)));
        }
    });
    out
}

fn creation_time(pid: u32) -> Option<u64> {
    process_times(pid).map(|(c, _)| c)
}

/// 트리 전체 누적 CPU 시간(ms). 유휴 판정(출력 없이 계산 중인 작업 보호)에 쓴다.
pub fn cpu_time_ms(pid: u32) -> u64 {
    process_tree(pid)
        .into_iter()
        .filter_map(process_times)
        .map(|(_, cpu)| cpu / 10_000)
        .sum()
}

/// 프로세스 트리 강제 종료(cmd → node 자식까지). 정지 상태여도 동작한다.
pub fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// FILETIME(1601년부터 100ns) → 유닉스 ms
fn filetime_to_unix_ms(t: u64) -> i64 {
    (t as i64 - 116_444_736_000_000_000) / 10_000
}

/// root 아래에서 since(유닉스 ms) 이후에 생긴 프로세스를 끈다(root는 남긴다). 끈 수.
/// 멈춘 명령 풀기: 멈춤 요청(interrupt)이 안 먹힐 때, 그 명령이 띄운 것(bash·node·헤드리스 크롬 등)만 골라 끈다 —
/// 명령보다 먼저 떠 있던 MCP 서버·백그라운드 작업은 건드리지 않는다.
pub fn kill_descendants_since(root: u32, since_unix_ms: i64) -> usize {
    let tree = process_tree(root);
    let young: Vec<u32> = tree
        .iter()
        .copied()
        .filter(|&p| p != root)
        .filter(|&p| creation_time(p).map(|c| filetime_to_unix_ms(c) >= since_unix_ms).unwrap_or(false))
        .collect();
    // 트리째 끈다(이미 꺼진 것을 또 끄는 건 무해)
    for p in &young {
        kill_tree(*p);
    }
    young.len()
}

static JOB_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// "닫히면 전부 종료" Job이 걸려 있는지 — 걸려 있으면 앱을 끄기만 해도 자식이 모두 꺼진다
pub fn job_active() -> bool {
    JOB_OK.load(std::sync::atomic::Ordering::SeqCst)
}

/// 앱 프로세스를 "닫히면 전부 종료" Job에 넣는다. 이후 만든 자식(claude/codex/pty와
/// 그 자손)은 Job을 상속하므로, 앱이 어떤 식으로 꺼지든(강제 종료 포함) 고아로 남지 않는다.
pub fn init_kill_on_close_job() -> Result<()> {
    unsafe {
        let job = CreateJobObjectW(None, None)?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        AssignProcessToJobObject(job, GetCurrentProcess())?;
        // 핸들은 일부러 닫지 않는다: 프로세스 종료 시 OS가 닫으면서 Job 전체가 종료된다.
    }
    JOB_OK.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// 지정 PID에 대해 핸들을 열고 클로저를 실행(정리 보장).
fn with_handle<F: FnOnce(HANDLE)>(pid: u32, access: PROCESS_ACCESS_RIGHTS, f: F) -> Result<()> {
    unsafe {
        let h = OpenProcess(access, FALSE, pid).map_err(|e| anyhow!("OpenProcess({pid}): {e}"))?;
        f(h);
        let _ = CloseHandle(h);
    }
    Ok(())
}

/// 작업 집합(RAM) 반납. 프로세스는 계속 실행.
pub fn trim(pid: u32) -> Result<()> {
    for p in process_tree(pid) {
        let _ = with_handle(p, PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, |h| unsafe {
            let _ = EmptyWorkingSet(h);
        });
    }
    Ok(())
}

/// 프로세스 트리 정지(일시정지) + 메모리 반납.
pub fn suspend(pid: u32) -> Result<()> {
    let nt = ntdll_fn(s!("NtSuspendProcess")).ok_or_else(|| anyhow!("NtSuspendProcess 로드 실패"))?;
    for p in process_tree(pid) {
        let _ = with_handle(p, PROCESS_SUSPEND_RESUME, |h| unsafe {
            nt(h);
        });
    }
    // 정지 후 메모리 반납(페이지가 standby/pagefile로 이동)
    let _ = trim(pid);
    Ok(())
}

/// 정지된 프로세스 트리 재개.
pub fn resume(pid: u32) -> Result<()> {
    let nt = ntdll_fn(s!("NtResumeProcess")).ok_or_else(|| anyhow!("NtResumeProcess 로드 실패"))?;
    for p in process_tree(pid) {
        let _ = with_handle(p, PROCESS_SUSPEND_RESUME, |h| unsafe {
            nt(h);
        });
    }
    Ok(())
}

/// 트리 전체 작업 집합(RAM) 합계(바이트).
pub fn working_set_bytes(pid: u32) -> u64 {
    let mut total = 0u64;
    for p in process_tree(pid) {
        let _ = with_handle(p, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, |h| unsafe {
            let mut pmc = PROCESS_MEMORY_COUNTERS {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ..Default::default()
            };
            if GetProcessMemoryInfo(h, &mut pmc, pmc.cb).is_ok() {
                total += pmc.WorkingSetSize as u64;
            }
        });
    }
    total
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    /// 멈춘 명령 풀기: 명령 시작 뒤에 생긴 자식만 끄고, 그 전부터 있던 자식은 남긴다
    #[test]
    fn kills_only_children_started_after() {
        use std::os::windows::process::CommandExt;
        let me = std::process::id();
        let mut old = std::process::Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 >nul"]).creation_flags(0x0800_0000).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let mut young = std::process::Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 >nul"]).creation_flags(0x0800_0000).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(800));
        let n = kill_descendants_since(me, since);
        std::thread::sleep(std::time::Duration::from_millis(800));
        let young_done = young.try_wait().unwrap().is_some();
        let old_alive = old.try_wait().unwrap().is_none();
        let _ = old.kill();
        let _ = young.kill();
        assert!(n >= 1, "새 자식(과 그 아래 ping)을 끈다");
        assert!(young_done, "새 자식은 꺼졌다");
        assert!(old_alive, "먼저 있던 자식은 남는다");
    }

    /// 모니터 한 바퀴(탭·에이전트 30개 메모리 조회)가 프로세스 스냅샷을 탭마다 새로 떠서 코어의 13%를 썼다
    #[test]
    fn one_snapshot_per_round_and_same_tree() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 4 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let me = std::process::id();
        let plain = process_tree(me);
        assert!(plain.contains(&child.id()), "자식이 트리에 있어야 한다");
        let before = SNAPSHOTS.load(std::sync::atomic::Ordering::SeqCst);
        let (a, b) = one_snapshot(|| (process_tree(me), process_tree(me)));
        let taken = SNAPSHOTS.load(std::sync::atomic::Ordering::SeqCst) - before;
        let _ = child.kill();
        assert_eq!(taken, 1, "한 바퀴에 스냅샷 하나");
        // cmd가 곧바로 ping을 띄우므로 두 시점의 트리는 다를 수 있다 — 같은 스냅샷 안에서는 같고, 자식은 양쪽에 있어야 한다
        assert!(a.contains(&child.id()));
        assert_eq!(a, b);
    }
}

#[cfg(test)]
mod snapshot_bench {
    /// cargo test --release --lib snapshot_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_round() {
        // 지금 떠 있는 claude 프로세스를 뿌리로(모니터가 실제로 조회하는 것과 비슷하게)
        let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\").ProcessId"]).output().unwrap();
        let roots: Vec<u32> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
        let t = std::time::Instant::now();
        let a: u64 = roots.iter().map(|&p| super::working_set_bytes(p)).sum();
        let plain = t.elapsed();
        let t = std::time::Instant::now();
        let b: u64 = super::one_snapshot(|| roots.iter().map(|&p| super::working_set_bytes(p)).sum());
        let shared = t.elapsed();
        println!("뿌리 {}개: 따로 {:?} · 한 장 {:?} (메모리 합 {}MB / {}MB)", roots.len(), plain, shared, a >> 20, b >> 20);
    }
}
