#![cfg_attr(not(feature = "multi-account"), allow(unused_variables))]
// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! AI Terminal Hub (BUILD_MARK aith-bk26-68a3b8a0b4ae) — Tauri 엔트리.

#[cfg_attr(not(feature = "multi-account"), allow(dead_code))]
mod accounts;
mod attach;
mod autostart;
mod claude;
mod codex;
mod fs;
mod monitor;
mod procctl;
mod pty;
mod recommend;
mod remote;
mod push;
mod rc;
mod github;
mod teamwt;
mod storage;
mod teamshare;
mod projmove;
mod modelhist;
mod flight;
mod portfolio;
mod cliupdate;
mod grass;
mod preview;
mod registry;
mod textread;
mod tools;
mod util;
mod watch;
mod collab;

use claude::ClaudeManager;
use codex::CodexManager;
use pty::PtyManager;
use watch::WatchManager;
use collab::WorkerManager;
use tauri::{AppHandle, Emitter, Manager, State};

// ---- 세션 ----

#[tauri::command]
fn session_create(
    app: AppHandle,
    mgr: State<PtyManager>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<Vec<(String, String)>>,
) -> Result<u32, String> {
    mgr.spawn(&app, id, program, args, cwd, cols, rows, env.unwrap_or_default())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn session_write(mgr: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    mgr.write(&id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_resize(mgr: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    mgr.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_kill(mgr: State<PtyManager>, id: String) -> Result<(), String> {
    mgr.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_pid(mgr: State<PtyManager>, id: String) -> Option<u32> {
    mgr.pid(&id)
}

// ---- 메모리 제어 ----

#[tauri::command]
fn session_trim(mgr: State<PtyManager>, id: String) -> Result<(), String> {
    mgr.trim(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_sleep(mgr: State<PtyManager>, id: String) -> Result<(), String> {
    mgr.sleep(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_wake(mgr: State<PtyManager>, id: String) -> Result<(), String> {
    mgr.wake(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_pin(mgr: State<PtyManager>, id: String, pinned: bool) {
    mgr.set_pinned(&id, pinned);
}

// ---- 설정 ----

#[tauri::command]
fn settings_get(app: AppHandle) -> serde_json::Value {
    registry::load(&app)
}

#[tauri::command]
fn settings_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    registry::save(&app, &value).map_err(|e| e.to_string())
}

// ---- 파일 탐색기 ----

#[tauri::command(async)]
fn fs_read_dir(path: String) -> Result<Vec<fs::Entry>, String> {
    fs::read_dir(&path)
}

#[tauri::command(async)]
fn fs_read_text(path: String, max_bytes: usize) -> Result<String, String> {
    fs::read_text(&path, max_bytes)
}

/// 작업 화면용 읽기: 바이너리 여부·인코딩까지 알려준다.
#[tauri::command(async)]
fn work_read(path: String, max_bytes: usize) -> Result<textread::TextRead, String> {
    textread::read(&path, max_bytes)
}

// ---- Claude 구조화 세션 ----

#[tauri::command]
fn claude_start(
    app: AppHandle,
    mgr: State<ClaudeManager>,
    id: String,
    cwd: String,
    model: Option<String>,
    permission: String,
    cont: bool,
    resume: Option<String>,
    bare: bool,
    gen: u64,
    account: Option<String>,
    lean: Option<bool>,
    effort: Option<String>,
    chrome: Option<bool>,
    compact_window: Option<u32>,
) -> Result<(), String> {
    let mut env = accounts::env_for(&app, account.as_deref());
    env.extend(claude::compact_env(compact_window));
    mgr.start(&app, id, cwd, model, permission, cont, resume, bare, gen, env, lean.unwrap_or(false), effort, chrome)
}

#[tauri::command]
fn claude_send(mgr: State<ClaudeManager>, id: String, text: String) -> Result<(), String> {
    mgr.send(&id, &text)
}

#[tauri::command]
fn claude_interrupt(mgr: State<ClaudeManager>, id: String) -> Result<(), String> {
    mgr.interrupt(&id)
}

/// 멈춘 명령 풀기: 그 에이전트 프로세스 아래에서 since(유닉스 ms) 뒤에 생긴 프로그램만 끈다. 끈 수
#[tauri::command(async)]
fn claude_kill_since(mgr: State<ClaudeManager>, id: String, since: i64) -> Result<usize, String> {
    let pid = mgr.pid_of(&id).ok_or("세션 없음")?;
    Ok(procctl::kill_descendants_since(pid, since))
}

#[tauri::command]
fn claude_sleep(mgr: State<ClaudeManager>, id: String) -> Result<(), String> {
    mgr.sleep(&id)
}

// 프로세스 트리를 끄고 끝나길 기다린다 → 메인 스레드(화면)를 막지 않게 async
#[tauri::command(async)]
fn claude_stop(mgr: State<'_, ClaudeManager>, id: String) -> Result<(), String> {
    mgr.stop(&id);
    Ok(())
}

/// 분배·팀 제안: 작은 모델 단발 호출 → 구조화 결과
#[tauri::command(async)]
fn claude_oneshot(app: AppHandle, cwd: String, model: String, system: String, prompt: String, schema: serde_json::Value, account: Option<String>) -> Result<serde_json::Value, String> {
    let env = accounts::env_for(&app, account.as_deref());
    claude::oneshot(&cwd, &model, &system, &prompt, &schema, env)
}

/// 이 폴더의 Claude 대화 목록(대화 고르기)
#[tauri::command(async)]
fn claude_sessions(cwd: String, limit: usize) -> serde_json::Value {
    claude::sessions(&cwd, limit)
}

/// 이 폴더의 Codex 대화 목록(대화 고르기)
#[tauri::command(async)]
fn codex_sessions(cwd: String, limit: usize) -> serde_json::Value {
    codex::sessions(&cwd, limit)
}

#[tauri::command(async)]
fn claude_transcript(cwd: String, session: Option<String>, limit: usize) -> serde_json::Value {
    claude::transcript(&cwd, session.as_deref(), limit)
}

// ---- 작업 화면: 파일 감시 / 기준 내용 ----

#[tauri::command]
fn watch_start(app: AppHandle, mgr: State<WatchManager>, id: String, cwd: String) -> Result<(), String> {
    mgr.start(&app, id, cwd)
}

#[tauri::command]
fn watch_stop(mgr: State<WatchManager>, id: String) {
    mgr.stop(&id);
}

#[tauri::command(async)]
fn file_baseline(cwd: String, path: String) -> Option<String> {
    watch::file_baseline(&cwd, &path)
}

// ---- AI 회사(협업 모드) ----
// git 작업은 시간이 걸릴 수 있어 async(별도 스레드)로 실행한다.

#[tauri::command(async)]
fn collab_changed(dir: String) -> Result<Vec<String>, String> {
    collab::changed_files(std::path::Path::new(&dir))
}

#[tauri::command(async)]
fn collab_diff(dir: String, max: usize) -> Result<String, String> {
    collab::ticket_diff(std::path::Path::new(&dir), max)
}

#[tauri::command(async)]
fn compare_prepare(repo: String, id: String) -> Result<serde_json::Value, String> {
    collab::compare_prepare(std::path::Path::new(&repo), &id)
}

#[tauri::command(async)]
fn compare_accept(repo: String, id: String, side: String, message: String) -> Result<String, String> {
    collab::compare_accept(std::path::Path::new(&repo), &id, &side, &message)
}

#[tauri::command(async)]
fn compare_discard(repo: String, id: String) {
    collab::compare_discard(std::path::Path::new(&repo), &id)
}

#[tauri::command]
fn collab_spawn(app: AppHandle, mgr: State<WorkerManager>, mut spec: collab::WorkerSpec) -> Result<u32, String> {
    spec.env = accounts::env_for(&app, spec.account.as_deref());
    mgr.spawn(&app, spec)
}

#[tauri::command]
fn collab_kill(mgr: State<WorkerManager>, key: String) {
    mgr.kill(&key);
}

#[tauri::command]
fn collab_reap(mgr: State<WorkerManager>, key: String) {
    mgr.reap(&key);
}

// ---- 추천 패널 ----

#[tauri::command(async)]
fn recommend_scan(cwd: String) -> recommend::Scan {
    recommend::scan(&cwd)
}

// ---- Codex 구조화 세션 ----

#[tauri::command]
fn codex_start(
    app: AppHandle,
    mgr: State<CodexManager>,
    id: String,
    cwd: String,
    model: Option<String>,
    sandbox: String,
    approval: String,
    resume: Option<String>,
    account: Option<String>,
) -> Result<(), String> {
    let env = accounts::env_for(&app, account.as_deref());
    mgr.start(id, cwd, model, sandbox, approval, resume, env)
}

// 남아 있던 이전 턴 프로세스를 끄고 기다릴 수 있다 → async
#[tauri::command(async)]
fn codex_send(
    app: AppHandle,
    mgr: State<'_, CodexManager>,
    id: String,
    text: String,
    turn: u64,
    compact_limit: Option<u64>,
    model: Option<String>,
    account: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    // account가 오면 이 턴부터 그 계정으로(한도 소진 시 전환)
    let env = account.map(|a| accounts::env_for(&app, Some(&a)));
    mgr.send(&app, &id, &text, turn, compact_limit, model, env, effort)
}

#[tauri::command]
fn codex_cancel(mgr: State<CodexManager>, id: String) {
    mgr.cancel(&id);
}

#[tauri::command(async)]
fn codex_limits() -> Option<serde_json::Value> {
    codex::latest_limits()
}

#[tauri::command(async)]
fn codex_transcript(cwd: String, thread: Option<String>, limit: usize) -> serde_json::Value {
    codex::transcript(&cwd, thread.as_deref(), limit)
}

#[tauri::command(async)]
fn codex_stop(mgr: State<'_, CodexManager>, id: String) -> Result<(), String> {
    mgr.stop(&id);
    Ok(())
}

// ---- 계정 풀 ----
// 계정 조회·한도 확인은 외부 프로그램을 실행하므로(수 초) 비동기 명령으로 UI를 막지 않는다.

/// 계정 여러 개(추가·삭제·순서·끄기·소진·전환·로그인 폴더) — 개발판(기본 기능 multi-account)만. 배포판에서는 이 코드가 빌드되지 않고 거절한다.
macro_rules! multi_account {
    ($e:expr) => {{
        #[cfg(feature = "multi-account")]
        {
            $e
        }
        #[cfg(not(feature = "multi-account"))]
        {
            Err("배포판에는 계정 여러 개 기능이 없어요".to_string())
        }
    }};
}

#[tauri::command(async)]
fn accounts_list(app: AppHandle) -> Vec<accounts::Account> {
    accounts::list(&app)
}

#[tauri::command(async)]
fn accounts_add(app: AppHandle, cli: String) -> Result<accounts::Account, String> {
    multi_account!(accounts::add(&app, &cli))
}

#[tauri::command(async)]
fn accounts_remove(app: AppHandle, id: String) -> Result<Vec<accounts::Account>, String> {
    multi_account!(accounts::remove(&app, &id))
}

#[tauri::command]
fn accounts_order(app: AppHandle, ids: Vec<String>) -> Result<Vec<accounts::Account>, String> {
    multi_account!(accounts::set_order(&app, ids))
}

#[tauri::command]
fn accounts_enable(app: AppHandle, id: String, on: bool) -> Result<Vec<accounts::Account>, String> {
    multi_account!(accounts::set_enabled(&app, &id, on))
}

#[tauri::command(async)]
fn accounts_refresh(app: AppHandle, id: String) -> Result<Vec<accounts::Account>, String> {
    accounts::refresh(&app, &id)
}

#[tauri::command]
fn accounts_note(app: AppHandle, id: String, limits: serde_json::Value) -> Result<Vec<accounts::Account>, String> {
    accounts::note(&app, &id, limits)
}

#[tauri::command]
fn accounts_exhaust(app: AppHandle, id: String, until: Option<i64>) -> Result<Vec<accounts::Account>, String> {
    multi_account!(accounts::exhaust(&app, &id, until))
}

#[tauri::command]
fn accounts_activate(app: AppHandle, id: String) -> Result<Vec<accounts::Account>, String> {
    multi_account!(accounts::activate(&app, &id))
}

/// GitHub 잔디 자동 올리기: 이 폴더의 바뀐 것을 커밋(작성자 noreply)해 origin에 올린다
#[tauri::command(async)]
fn grass_commit(dir: String, email: String) -> grass::GrassResult {
    let git_name = std::process::Command::new("git").args(["config", "--global", "user.name"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let name = grass::author_name(git_name, &email);
    grass::commit_and_push(&dir, &name, &email)
}

/// 그 Claude 계정의 로그인 정보 파일 수정 시각(ms). 내용은 읽지 않는다 — 로그인이 풀린 뒤 다시 로그인됐는지만 본다
#[tauri::command(async)]
fn claude_login_stamp(app: AppHandle, account: Option<String>) -> Option<i64> {
    let env = accounts::env_for(&app, account.as_deref());
    let dir = env
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| std::path::PathBuf::from(v))
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude"));
    let t = std::fs::metadata(dir.join(".credentials.json")).and_then(|m| m.modified()).ok()?;
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

#[tauri::command]
fn accounts_pick(app: AppHandle, cli: String) -> Option<String> {
    accounts::pick_for(&app, &cli)
}

#[tauri::command]
fn accounts_login_spec(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    multi_account!(accounts::login_spec(&app, &id))
}

// ---- 자동 시작 ----

#[tauri::command]
fn autostart_get() -> bool {
    autostart::get()
}

#[tauri::command]
fn autostart_set(on: bool) -> Result<(), String> {
    autostart::set(on)
}

// ---- 모바일 원격 제어(claude remote-control) ----

/// PATH에서 명령을 찾는다(다른 CLI 에이전트 설치 여부 표시용). 없으면 None
#[tauri::command(async)]
fn which_cli(names: Vec<String>) -> Vec<Option<String>> {
    let path = std::env::var("PATH").unwrap_or_default();
    names
        .iter()
        .map(|n| {
            if !util::safe_arg(n) {
                return None;
            }
            path.split(';').filter(|d| !d.is_empty()).find_map(|d| {
                ["exe", "cmd", "bat", "ps1"]
                    .iter()
                    .map(|e| std::path::Path::new(d).join(format!("{n}.{e}")))
                    .find(|p| p.is_file())
                    .map(|p| p.to_string_lossy().into_owned())
            })
        })
        .collect()
}

/// 폴더를 탐색기로, https 주소는 기본 브라우저로 연다(AI 회사 작업 공간, GitHub PR 등)
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let url = path.starts_with("https://") || path.starts_with("http://localhost") || path.starts_with("http://127.0.0.1");
    if url && path.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("잘못된 주소".into());
    }
    if !url && !std::path::Path::new(&path).exists() {
        return Err(format!("경로가 없어요: {path}"));
    }
    std::process::Command::new("explorer.exe").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn remote_list(app: AppHandle) -> Vec<remote::Remote> {
    app.state::<remote::RemoteManager>().list()
}

/// 이 폴더를 폰(Claude 앱 Code 탭·claude.ai/code)에서 열 수 있게 한다.
/// 지금 쓰는 Claude·Codex 계정으로 띄우고, "@co" 메시지를 Codex로 넘기는 프롬프트 훅을 그 계정 설정에 등록한다.
#[tauri::command]
fn remote_start(app: AppHandle, cwd: String, full: bool) -> Result<remote::Remote, String> {
    let mut env = accounts::env_for(&app, accounts::pick_for(&app, "claude").as_deref());
    env.extend(accounts::env_for(&app, accounts::pick_for(&app, "codex").as_deref()));
    let bin = app.path().app_data_dir().map_err(|e| e.to_string())?.join("bin");
    let config = env
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| std::path::PathBuf::from(v))
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude"));
    tools::ensure_prompt_hook(&config.join("settings.json"), &bin)?;
    app.state::<remote::RemoteManager>().start(&app, &cwd, env, full)
}

#[tauri::command]
fn remote_stop(app: AppHandle, cwd: String) {
    app.state::<remote::RemoteManager>().stop(&app, &cwd);
}

// ---- 앱 종료 ----

/// 실행 중인 모든 세션 수(터미널 + Claude 구조화 + 턴 실행 중인 Codex).
fn running_sessions(app: &AppHandle) -> usize {
    app.state::<PtyManager>().count()
        + app.state::<ClaudeManager>().count()
        + app.state::<CodexManager>().running_count()
        + app.state::<WorkerManager>().count()
}

#[tauri::command]
fn session_count(app: AppHandle) -> usize {
    running_sessions(&app)
}

/// "모두 종료하고 닫기": 창을 먼저 숨기고 바로 끈다. 자식 프로세스는 "닫히면 전부 종료" Job이 함께 끈다.
/// (세션마다 taskkill을 기다리면 수십 개일 때 창이 '응답 없음'이 되고, 그사이 꺼진 세션들이 오류를 띄웠다)
/// Job을 못 걸었을 때만 화면 스레드 밖에서 하나씩 정리한 뒤 끈다.
#[tauri::command]
fn force_quit(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    if procctl::job_active() {
        app.exit(0);
        return;
    }
    std::thread::spawn(move || {
        app.state::<PtyManager>().kill_all();
        app.state::<ClaudeManager>().stop_all();
        app.state::<CodexManager>().stop_all();
        app.state::<WorkerManager>().kill_all();
        app.state::<remote::RemoteManager>().stop_all(&app);
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    // 자동 업데이트는 배포판만(개발판 설정에는 업데이트 주소·키가 없다)
    #[cfg(not(feature = "multi-account"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init());
    builder
        .manage(PtyManager::default())
        .manage(ClaudeManager::default())
        .manage(CodexManager::default())
        .manage(WatchManager::default())
        .manage(WorkerManager::default())
        .manage(remote::RemoteManager::default())
        .invoke_handler(tauri::generate_handler![
            session_create,
            session_write,
            session_resize,
            session_kill,
            session_pid,
            session_trim,
            session_sleep,
            session_wake,
            session_pin,
            settings_get,
            settings_save,
            fs_read_dir,
            fs_read_text,
            work_read,
            claude_start,
            claude_send,
            claude_stop,
            claude_sleep,
            claude_interrupt,
            claude_kill_since,
            codex::codex_models,
            claude_transcript,
            claude_sessions,
            claude_oneshot,
            codex_sessions,
            recommend_scan,
            watch_start,
            watch_stop,
            file_baseline,
            collab_changed,
            collab_diff,
            collab_spawn,
            collab_kill,
            collab_reap,
            codex_start,
            codex_send,
            codex_cancel,
            codex_stop,
            codex_transcript,
            codex_limits,
            accounts_list,
            accounts_add,
            accounts_remove,
            accounts_order,
            accounts_enable,
            accounts_refresh,
            claude_login_stamp,
            grass_commit,
            accounts_note,
            accounts_exhaust,
            accounts_pick,
            accounts_activate,
            accounts_login_spec,
            autostart_get,
            autostart_set,
            remote_list,
            open_path,
            which_cli,
            preview::preview_probe,
            github::gh_pr_create,
            github::gh_login,
            github::gh_repo_create,
            github::gh_noreply,
            cliupdate::cli_update,
            portfolio::portfolio_scan,
            portfolio::gh_profile_get,
            portfolio::gh_profile_put,
            portfolio::gh_profile_create,
            compare_prepare,
            compare_accept,
            compare_discard,
            push::notify_push,
            teamwt::team_kind,
            teamwt::team_repo,
            teamwt::team_init,
            teamwt::team_wt,
            teamwt::team_merge,
            teamwt::team_branch_exists,
            storage::storage_tmp_sweep,
            storage::storage_free,
            storage::storage_wt_sweep,
            storage::storage_codex_own,
            storage::storage_logs_sweep,
            teamshare::team_remote,
            flight::team_flight_save,
            flight::team_flight_take,
            teamshare::team_new_branch,
            teamshare::team_push_pr,
            projmove::project_move,
            modelhist::session_model_before,
            teamwt::team_sync,
            teamwt::team_diffstat,
            teamwt::claude_session_copy,
            rc::rc_ack,
            rc::rc_ready,
            attach::attach_save,
            rc::rc_reply,
            remote_start,
            remote_stop,
            session_count,
            force_quit
        ])
        .on_window_event(|window, event| {
            // 실행 중 세션이 있으면 바로 닫지 않고 프론트에 확인 요청(메인 창만 — 다른 창을 닫는다고 앱 종료를 묻지 않게)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && running_sessions(window.app_handle()) > 0 {
                    api.prevent_close();
                    let _ = window.emit("app-close-request", ());
                }
            }
        })
        .setup(|app| {
            // 앱이 어떻게 꺼지든 자식 프로세스(claude/codex/터미널)가 함께 종료되게 한다.
            if let Err(e) = procctl::init_kill_on_close_job() {
                eprintln!("kill-on-close job 설정 실패: {e}");
            }
            // 에이전트용 aith-open(GUI 프로그램을 허브와 분리해 실행) — 모든 자식이 PATH로 쓴다
            if let Some(bin) = tools::install(app.handle()) {
                tools::add_to_path(&bin);
            }
            monitor::start(app.handle().clone());
            // 폰(원격 세션) 요청 받기 — aith-hub / aith-codex
            rc::start(app.handle().clone());
            // 컴퓨터 시작 시 자동 실행이면 방해되지 않게 최소화(탭 복원은 평소대로)
            if autostart::launched_by_autostart() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.minimize();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
