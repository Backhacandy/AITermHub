// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 모바일 원격 제어: 프로젝트 폴더마다 `claude remote-control`을 띄워 두면
//! 폰 Claude 앱(Code 탭)·claude.ai/code에서 그 폴더의 Claude를 조종할 수 있다.
//! 원격 세션에는 AITH_REMOTE=1을 넘겨, "@co …" 메시지는 프롬프트 훅이 Codex(aith-codex)로 넘기게 한다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub cwd: String,
    pub name: String,
    /// "starting" | "connected" | "error" | "stopped"
    pub status: String,
    /// claude.ai/code에서 이 폴더 환경을 여는 주소
    pub url: Option<String>,
    pub error: Option<String>,
    pub pid: u32,
}

struct Entry {
    info: Arc<Mutex<Remote>>,
    child: Child,
}

#[derive(Default)]
pub struct RemoteManager {
    map: Mutex<HashMap<String, Entry>>,
}

fn key(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/']).to_lowercase()
}

/// 터미널 제어 문자(색·커서 이동·OSC 링크) 제거
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: BEL 또는 ESC \ 까지
                it.next();
                while let Some(n) = it.next() {
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        it.next();
                        break;
                    }
                }
            }
            _ => {
                it.next();
            }
        }
    }
    out
}

/// 출력 한 조각을 상태에 반영. 바뀌었으면 true
pub fn apply_output(info: &mut Remote, raw: &str) -> bool {
    let before = info.clone();
    if let Some(i) = raw.find("https://claude.ai/code?environment=") {
        let url: String = raw[i..].chars().take_while(|c| !c.is_whitespace() && *c != '\x1b' && *c != '\x07').collect();
        info.url = Some(url);
    }
    let text = strip_ansi(raw);
    // 화면이 계속 다시 그려지므로 가장 나중에 나온 상태를 따른다
    let ok = text.rfind("Connected");
    let lost = [text.rfind("Reconnecting"), text.rfind("Disconnected")].into_iter().flatten().max();
    match (ok, lost) {
        (Some(a), Some(b)) if b > a => info.status = "starting".into(),
        (Some(_), _) => {
            info.status = "connected".into();
            info.error = None;
        }
        (None, Some(_)) => info.status = "starting".into(),
        _ => {}
    }
    let low = text.to_lowercase();
    if low.contains("must be logged in") || low.contains("not logged in") || low.contains("subscription") && low.contains("required") {
        info.status = "error".into();
        info.error = Some("이 계정으로 Claude 구독 로그인이 필요해요".into());
    } else if low.contains("workspace not trusted") {
        info.status = "error".into();
        info.error = Some("이 폴더를 아직 신뢰하지 않았어요 — 터미널에서 이 폴더로 claude를 한 번 실행해 신뢰를 수락한 뒤 다시 켜 주세요".into());
    } else if let Some(l) = text.lines().find(|l| l.trim_start().starts_with("Error") || l.contains("error:")) {
        info.status = "error".into();
        info.error = Some(l.trim().chars().take(200).collect());
    }
    *info != before
}

// ---------- 폴더 신뢰(계정별 .claude.json) ----------
//
// `claude remote-control`은 폴더를 신뢰해야 뜬다. 신뢰는 설정 폴더(계정)마다 .claude.json에 따로 남아서,
// 기본 계정에서 신뢰한 폴더도 추가 계정으로 띄우면 "Workspace not trusted"가 된다.
// → 기본 계정이 그 폴더(또는 상위 폴더)를 이미 신뢰했을 때만 같은 표시를 추가 계정에도 적는다.

fn norm_dir(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// 이 설정(.claude.json 내용)이 cwd 또는 그 상위 폴더를 신뢰하는지
fn trusts(cfg: &serde_json::Value, cwd: &str) -> bool {
    let want = norm_dir(cwd);
    cfg.get("projects").and_then(|p| p.as_object()).is_some_and(|m| {
        m.iter().any(|(k, v)| {
            let k = norm_dir(k);
            v.get("hasTrustDialogAccepted").and_then(|x| x.as_bool()) == Some(true) && (want == k || want.starts_with(&format!("{k}/")))
        })
    })
}

/// 기본 계정 설정(`default_file`)이 신뢰하는 폴더면 계정 설정(`account_file`)에도 신뢰 표시. 적었으면 true
fn sync_trust(default_file: &Path, account_file: &Path, cwd: &str) -> Result<bool, String> {
    let read = |p: &Path| -> Option<serde_json::Value> { serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok() };
    let Some(def) = read(default_file) else { return Ok(false) };
    if !trusts(&def, cwd) {
        return Ok(false);
    }
    let mut acct = if account_file.exists() {
        read(account_file).ok_or("계정 설정 파일을 읽지 못했어요")?
    } else {
        serde_json::json!({})
    };
    if trusts(&acct, cwd) {
        return Ok(false);
    }
    // Claude가 쓰는 키 모양(`C:/MyGame`, 드라이브 루트는 `C:/`)
    let slashed = cwd.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    let key = if trimmed.ends_with(':') { format!("{trimmed}/") } else { trimmed.to_string() };
    let obj = acct.as_object_mut().ok_or("계정 설정 형식이 달라요")?;
    let projects = obj.entry("projects").or_insert_with(|| serde_json::json!({}));
    let entry = projects.as_object_mut().ok_or("계정 설정 형식이 달라요")?.entry(key).or_insert_with(|| serde_json::json!({}));
    entry.as_object_mut().ok_or("계정 설정 형식이 달라요")?.insert("hasTrustDialogAccepted".into(), true.into());
    let tmp = account_file.with_extension("json.aith-tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&acct).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, account_file).map_err(|e| e.to_string())?;
    Ok(true)
}

fn folder_name(cwd: &str) -> String {
    Path::new(cwd.trim_end_matches(['\\', '/']))
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".into())
}

impl RemoteManager {
    pub fn list(&self) -> Vec<Remote> {
        let mut map = self.map.lock().unwrap();
        // 끝난 프로세스는 상태만 정리
        for e in map.values_mut() {
            if let Ok(Some(_)) = e.child.try_wait() {
                let mut i = e.info.lock().unwrap();
                if i.status != "error" {
                    i.status = "stopped".into();
                }
            }
        }
        let mut v: Vec<Remote> = map.values().map(|e| e.info.lock().unwrap().clone()).collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// `env`: Claude 계정(CLAUDE_CONFIG_DIR)·Codex 계정(CODEX_HOME) 환경, `full`: 전체 권한
    pub fn start(&self, app: &AppHandle, cwd: &str, env: Vec<(String, String)>, full: bool) -> Result<Remote, String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("폴더가 없어요: {cwd}"));
        }
        let k = key(cwd);
        {
            let mut map = self.map.lock().unwrap();
            if let Some(e) = map.get_mut(&k) {
                if matches!(e.child.try_wait(), Ok(None)) {
                    return Ok(e.info.lock().unwrap().clone());
                }
                map.remove(&k);
            }
        }
        let name = folder_name(cwd);
        // 추가 계정으로 띄우면 그 계정 설정에도 폴더 신뢰가 있어야 한다(기본 계정이 신뢰한 폴더일 때만 옮겨 적음)
        if let Some((_, dir)) = env.iter().find(|(k, _)| k == "CLAUDE_CONFIG_DIR") {
            let home = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
            let _ = sync_trust(&home.join(".claude.json"), &Path::new(dir).join(".claude.json"), cwd);
        }
        let (exe, pre) = crate::collab::resolve_cli("claude");
        let mut cmd = Command::new(exe);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.args(pre)
            .args(["remote-control", "--name", &name, "--permission-mode", if full { "bypassPermissions" } else { "acceptEdits" }])
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
        cmd.env("AITH_REMOTE", "1").env("AITH_FULL", if full { "1" } else { "0" });
        let mut child = cmd.spawn().map_err(|e| format!("claude 실행 실패: {e}"))?;
        let info = Arc::new(Mutex::new(Remote {
            cwd: cwd.to_string(),
            name,
            status: "starting".into(),
            url: None,
            error: None,
            pid: child.id(),
        }));
        let stdin: Arc<Mutex<Option<ChildStdin>>> = Arc::new(Mutex::new(child.stdin.take()));
        for out in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
        {
            let (info, stdin, app) = (info.clone(), stdin.clone(), app.clone());
            std::thread::spawn(move || pump(out, info, stdin, app));
        }
        let snap = info.lock().unwrap().clone();
        self.map.lock().unwrap().insert(k, Entry { info, child });
        let _ = app.emit("remote-status", &snap);
        Ok(snap)
    }

    pub fn stop(&self, app: &AppHandle, cwd: &str) {
        if let Some(mut e) = self.map.lock().unwrap().remove(&key(cwd)) {
            crate::procctl::kill_tree(e.child.id());
            let _ = e.child.kill();
            let _ = e.child.wait();
            let mut i = e.info.lock().unwrap();
            i.status = "stopped".into();
            let _ = app.emit("remote-status", &*i);
        }
    }

    pub fn stop_all(&self, app: &AppHandle) {
        let keys: Vec<String> = self.map.lock().unwrap().values().map(|e| e.info.lock().unwrap().cwd.clone()).collect();
        for k in keys {
            self.stop(app, &k);
        }
    }

    pub fn count(&self) -> usize {
        self.list().iter().filter(|r| r.status != "stopped").count()
    }
}

/// 출력을 읽어 상태 갱신. 처음 한 번 묻는 "Enable Remote Control? (y/n)"에는 y로 답한다
/// (사용자가 허브에서 직접 켠 경우에만 이 프로세스가 뜬다).
fn pump(mut out: Box<dyn Read + Send>, info: Arc<Mutex<Remote>>, stdin: Arc<Mutex<Option<ChildStdin>>>, app: AppHandle) {
    let mut buf = [0u8; 8192];
    let mut tail = String::new();
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        tail.push_str(&String::from_utf8_lossy(&buf[..n]));
        if tail.len() > 16_000 {
            let cut = tail.len() - 8_000;
            let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(0);
            tail.drain(..cut);
        }
        if tail.contains("Enable Remote Control?") {
            if let Some(si) = stdin.lock().unwrap().as_mut() {
                let _ = si.write_all(b"y\n");
                let _ = si.flush();
            }
            tail = tail.replace("Enable Remote Control?", "");
        }
        let mut i = info.lock().unwrap();
        if apply_output(&mut i, &tail) {
            let _ = app.emit("remote-status", &*i);
        }
        // 같은 화면이 계속 다시 그려지므로 마지막 부분만 다음 판단에 쓴다
        if tail.len() > 4_000 {
            let cut = tail.len() - 2_000;
            let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(0);
            tail.drain(..cut);
        }
    }
    let mut i = info.lock().unwrap();
    if i.status != "error" {
        i.status = "stopped".into();
    }
    let _ = app.emit("remote-status", &*i);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_is_copied_only_when_default_account_trusts_folder_or_parent() {
        let base = std::env::temp_dir().join(format!("aith-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("acct")).unwrap();
        let def = base.join("default.json");
        std::fs::write(&def, r#"{"projects":{"C:/":{"hasTrustDialogAccepted":true},"D:/Game":{"hasTrustDialogAccepted":false},"D:/Other":{"hasTrustDialogAccepted":true}}}"#).unwrap();
        let def_v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&def).unwrap()).unwrap();
        // 상위 폴더(C:/)를 신뢰하면 그 아래도, 대소문자·구분자 무시. 이름만 비슷한 폴더(D:/Other ↛ D:/Oth)는 아님
        assert!(trusts(&def_v, "C:\\MyGame"));
        assert!(trusts(&def_v, "d:\\other\\sub\\"));
        assert!(!trusts(&def_v, "D:\\Game"));
        assert!(!trusts(&def_v, "D:\\Oth"));

        // 계정 설정 파일이 있으면 다른 내용은 그대로 두고 그 폴더만 신뢰 표시
        let acct = base.join("acct").join(".claude.json");
        std::fs::write(&acct, r#"{"userID":"u","projects":{"C:/X":{"allowedTools":["Read"]}}}"#).unwrap();
        assert_eq!(sync_trust(&def, &acct, "C:\\MyGame"), Ok(true));
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&acct).unwrap()).unwrap();
        assert_eq!(v["userID"], "u");
        assert_eq!(v["projects"]["C:/X"]["allowedTools"][0], "Read");
        assert_eq!(v["projects"]["C:/MyGame"]["hasTrustDialogAccepted"], true);
        // 이미 신뢰면 다시 쓰지 않음, 기본 계정이 신뢰하지 않은 폴더는 손대지 않음
        assert_eq!(sync_trust(&def, &acct, "C:\\MyGame"), Ok(false));
        assert_eq!(sync_trust(&def, &acct, "D:\\Game"), Ok(false));
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&acct).unwrap()).unwrap();
        assert!(v["projects"].get("D:/Game").is_none());
        // 계정 설정 파일이 아직 없으면 만든다
        let fresh = base.join("acct").join("new.json");
        assert_eq!(sync_trust(&def, &fresh, "C:\\p"), Ok(true));
        let _ = std::fs::remove_dir_all(&base);
    }

    fn blank() -> Remote {
        Remote { cwd: "C:\\p".into(), name: "p".into(), status: "starting".into(), url: None, error: None, pid: 1 }
    }

    #[test]
    fn strips_ansi_and_osc_links() {
        let s = "\x1b[32m·✔︎· Connected\x1b[0m \x1b]8;;https://claude.ai/code/session_1?from=cli\x07AITermHub\x1b]8;;\x07";
        assert_eq!(strip_ansi(s), "·✔︎· Connected AITermHub");
    }

    #[test]
    fn detects_connected_and_url() {
        let mut r = blank();
        let raw = "\x1b[1m·✔︎· Connected · AITermHub · main\x1b[0m\r\nContinue coding in the Claude mobile app or https://claude.ai/code?environment=env_013dJ\r\n";
        assert!(apply_output(&mut r, raw));
        assert_eq!(r.status, "connected");
        assert_eq!(r.url.as_deref(), Some("https://claude.ai/code?environment=env_013dJ"));
        // 같은 화면이 다시 와도 바뀐 것 없음
        assert!(!apply_output(&mut r, raw));
    }

    #[test]
    fn detects_login_error() {
        let mut r = blank();
        assert!(apply_output(&mut r, "You must be logged in with a Claude account"));
        assert_eq!(r.status, "error");
    }

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("C:\\MyGame\\"), "MyGame");
        assert_eq!(key("C:\\A\\"), key("c:\\a"));
    }
}
