// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 폰(원격 Claude 세션) → 허브 요청 통로. 파일로 주고받아 포트를 열지 않는다.
//! aith-hub / aith-codex가 app_data/rc/inbox/<id>.json을 쓰면 파일 감시로 바로 읽어 "rc-request"로 화면에 넘기고,
//! 화면은 rc_ack(받았음) → rc_reply(결과)로 outbox/<id>.ack · <id>.txt에 답을 쓴다.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

fn root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("rc"))
}

/// 요청 id: 영문·숫자·-만(파일 이름으로 씀)
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 요청 파일 내용 → 화면에 넘길 값(형식이 틀리면 None)
pub fn parse_request(text: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let id = v.get("id")?.as_str()?;
    let kind = v.get("kind")?.as_str()?;
    if !valid_id(id) || !["status", "pair", "codex"].contains(&kind) {
        return None;
    }
    Some(v)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 하루 지난 파일 정리(응답을 못 가져간 것 등)
fn sweep(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let old = SystemTime::now() - Duration::from_secs(86_400);
    for e in rd.flatten() {
        if e.metadata().and_then(|m| m.modified()).map(|t| t < old).unwrap_or(false) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// inbox의 *.json 요청을 읽어 지우고, 형식이 맞는 것만 돌려준다(쓰는 중인 .tmp는 그대로, 깨진 JSON은 지움)
fn drain(inbox: &Path) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(inbox) else { return vec![] };
    let mut out = vec![];
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x != "json").unwrap_or(true) {
            continue;
        }
        // 못 읽으면(백신 등이 잡고 있음) 지우지 않고 다음 기회에 다시 본다
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let _ = std::fs::remove_file(&p);
        if let Some(v) = parse_request(&text) {
            out.push(v);
        }
    }
    out
}

/// 앱 시작: 폴더만 준비한다. 요청 읽기는 화면이 rc-request를 듣기 시작한 뒤(rc_ready)부터 —
/// 이벤트는 쌓이지 않아서, 먼저 읽으면 꺼져 있던 동안 쌓인 요청을 듣는 이 없이 지워 버린다.
pub fn start(app: AppHandle) {
    let Some(root) = root(&app) else { return };
    let inbox = root.join("inbox");
    let outbox = root.join("outbox");
    let _ = std::fs::create_dir_all(&inbox);
    let _ = std::fs::create_dir_all(&outbox);
    sweep(&inbox);
    sweep(&outbox);
}

static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 화면이 rc-request를 듣기 시작했다: 감시를 먼저 걸고(그 사이 들어온 요청도 놓치지 않게) 쌓인 요청을 읽는다.
/// 쉬는 동안 돌지 않게 파일 감시로 — 요청 파일이 생기거나(.tmp → .json 이름 바꾸기 포함) 바뀔 때만 읽는다.
#[tauri::command]
pub fn rc_ready(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if READY.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(root) = root(&app) else { return };
    let inbox = root.join("inbox");
    let _ = std::fs::create_dir_all(&inbox);
    let emit_all = {
        let app = app.clone();
        move |inbox: &Path| {
            for v in drain(inbox) {
                let _ = app.emit("rc-request", v);
            }
        }
    };
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(tx).and_then(|mut w| w.watch(&inbox, RecursiveMode::NonRecursive).map(|_| w));
    match watcher {
        Ok(w) => {
            let dir = inbox.clone();
            let emit = emit_all.clone();
            std::thread::spawn(move || {
                let _keep = w; // 감시자를 이 스레드가 쥐고 있어야 이벤트가 온다
                // 어떤 이벤트든(오류·넘침 포함) 다시 읽는다 — 빠진 이벤트가 있어도 다음에 따라잡게
                for _ in rx {
                    emit(&dir);
                }
            });
        }
        Err(e) => {
            eprintln!("[rc] 파일 감시를 못 해 1초 확인으로 돌아감: {e}");
            let dir = inbox.clone();
            let emit = emit_all.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                emit(&dir);
            });
        }
    }
    // 꺼져 있던 동안 쌓인 요청
    emit_all(&inbox);
}

fn out_path(app: &AppHandle, id: &str, ext: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("잘못된 요청 id".into());
    }
    let dir = root(app).ok_or("앱 폴더 없음")?.join("outbox");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join(format!("{id}.{ext}")))
}

#[tauri::command]
pub fn rc_ack(app: AppHandle, id: String, text: String) -> Result<(), String> {
    write_atomic(&out_path(&app, &id, "ack")?, &text)
}

#[tauri::command]
pub fn rc_reply(app: AppHandle, id: String, text: String) -> Result<(), String> {
    write_atomic(&out_path(&app, &id, "txt")?, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_takes_requests_and_skips_partial_or_broken() {
        let dir = std::env::temp_dir().join(format!("aith-rc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a1.json"), r#"{"id":"a1","kind":"status"}"#).unwrap();
        std::fs::write(dir.join("b2.json"), "not json").unwrap();
        std::fs::write(dir.join("c3.tmp"), r#"{"id":"c3","kind":"status"}"#).unwrap();
        let got = drain(&dir);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], "a1");
        assert!(!dir.join("a1.json").exists());
        assert!(!dir.join("b2.json").exists());
        assert!(dir.join("c3.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drain_keeps_files_it_could_not_read() {
        let dir = std::env::temp_dir().join(format!("aith-rc-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x1.json");
        std::fs::write(&p, r#"{"id":"x1","kind":"status"}"#).unwrap();
        // 백신 등이 막 생긴 파일을 잡고 있는 경우: 읽기는 막히고 지우기는 되는 잠금(FILE_SHARE_DELETE만)
        use std::os::windows::fs::OpenOptionsExt;
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0x4).open(&p).unwrap();
        assert!(drain(&dir).is_empty());
        assert!(p.exists(), "읽지 못한 요청은 지우지 않고 다음 기회에 다시 본다");
        drop(lock);
        assert_eq!(drain(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_rules() {
        assert!(parse_request(r#"{"id":"a1b2","kind":"status"}"#).is_some());
        assert!(parse_request("\u{feff}{\"id\":\"x-1\",\"kind\":\"pair\",\"cwd\":\"C:\\\\p\",\"text\":\"하이\"}").is_some());
        assert!(parse_request(r#"{"id":"../x","kind":"status"}"#).is_none());
        assert!(parse_request(r#"{"id":"a","kind":"rm"}"#).is_none());
        assert!(parse_request("not json").is_none());
    }
}
