// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 작업 중 파일 변경 감시: 턴이 도는 동안만 프로젝트 폴더를 재귀 감시해
//! 바뀐 파일을 "work-fs-change" {id, changes:[{path, kind}]}로 알린다.
//! (Windows의 Codex는 파일을 PowerShell로 직접 고쳐서 도구 이벤트만으로는 알 수 없다.)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter};

const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "build", "dist", ".svelte-kit", ".next", "__pycache__", ".venv",
    // 자동 진행(AI 회사) 작업 공간
    ".aith",
    // 게임 엔진·IDE 빌드 산출물(Unity Library/Temp/Logs/obj, Unreal Intermediate·DerivedDataCache, Gradle, VS)
    // — 빌드 중 수천 개씩 바뀌어 감시가 앱을 멈추게 했다
    "library", "temp", "logs", "obj", "intermediate", "deriveddatacache", ".gradle", ".vs", ".idea",
];
const MAX_PATHS: usize = 200;
const DEBOUNCE: Duration = Duration::from_millis(300);

/// root 밖이거나 무거운 폴더(.git, node_modules 등) 안이면 무시.
pub fn is_ignored(root: &Path, p: &Path) -> bool {
    match p.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .any(|c| IGNORED_DIRS.iter().any(|d| c.as_os_str().eq_ignore_ascii_case(d))),
        Err(_) => true,
    }
}

fn kind_of(k: &EventKind) -> Option<&'static str> {
    match k {
        EventKind::Create(_) => Some("create"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Remove(_) => Some("remove"),
        _ => None,
    }
}

/// 같은 파일의 이벤트 합치기: 생성 후 삭제 = 없던 일(임시 파일), 생성 후 수정 = 생성,
/// 삭제 후 생성 = 수정(편집기의 저장 방식), 그 외엔 마지막 이벤트.
fn merge(batch: &mut HashMap<PathBuf, &'static str>, p: PathBuf, kind: &'static str) {
    match (batch.get(&p).copied(), kind) {
        (Some("create"), "remove") => {
            batch.remove(&p);
        }
        (Some("create"), _) => {}
        (Some("remove"), "create") => {
            batch.insert(p, "modify");
        }
        _ => {
            batch.insert(p, kind);
        }
    }
}

fn collect(root: &Path, ev: notify::Result<notify::Event>, batch: &mut HashMap<PathBuf, &'static str>) {
    let Ok(ev) = ev else { return };
    let Some(kind) = kind_of(&ev.kind) else { return };
    for p in ev.paths {
        if is_ignored(root, &p) || p.is_dir() {
            continue;
        }
        merge(batch, p, kind);
    }
}

fn emit(app: &AppHandle, id: &str, batch: HashMap<PathBuf, &'static str>) {
    if batch.is_empty() {
        return;
    }
    let changes: Vec<_> = batch
        .into_iter()
        .take(MAX_PATHS)
        .map(|(p, k)| json!({ "path": p.to_string_lossy(), "kind": k }))
        .collect();
    let _ = app.emit("work-fs-change", json!({ "id": id, "changes": changes }));
}

/// 이벤트를 DEBOUNCE 동안 모아 한 번에 보낸다. 감시자가 drop되면 채널이 끊겨 종료.
fn run(app: AppHandle, id: String, root: PathBuf, rx: mpsc::Receiver<notify::Result<notify::Event>>) {
    while let Ok(first) = rx.recv() {
        let mut batch = HashMap::new();
        collect(&root, first, &mut batch);
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(ev) => collect(&root, ev, &mut batch),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    emit(&app, &id, batch);
                    return;
                }
            }
        }
        emit(&app, &id, batch);
    }
}

#[derive(Default)]
pub struct WatchManager {
    active: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatchManager {
    pub fn start(&self, app: &AppHandle, id: String, cwd: String) -> Result<(), String> {
        if self.active.lock().unwrap().contains_key(&id) {
            return Ok(());
        }
        let root = PathBuf::from(&cwd);
        let (tx, rx) = mpsc::channel();
        let mut w = notify::recommended_watcher(tx).map_err(|e| format!("감시 시작 실패: {e}"))?;
        w.watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("감시 시작 실패: {e}"))?;
        let app = app.clone();
        let id2 = id.clone();
        std::thread::spawn(move || run(app, id2, root, rx));
        self.active.lock().unwrap().insert(id, w);
        Ok(())
    }

    /// 감시 중지. 감시자를 drop하면 채널이 끊겨 스레드도 끝난다.
    pub fn stop(&self, id: &str) {
        self.active.lock().unwrap().remove(id);
    }
}

/// cwd 기준 상대경로(`/` 구분, 대소문자 무시). cwd 밖이면 None.
pub fn rel_path(cwd: &str, path: &str) -> Option<String> {
    let c = cwd.replace('\\', "/");
    let c = c.trim_end_matches('/');
    let p = path.replace('\\', "/");
    let head = p.get(..c.len())?;
    if head.eq_ignore_ascii_case(c) && p.as_bytes().get(c.len()) == Some(&b'/') {
        Some(p[c.len() + 1..].to_string())
    } else {
        None
    }
}

/// 변경 전 기준 내용: git이 추적하는 파일이면 마지막 커밋(HEAD) 버전, 아니면 None.
pub fn file_baseline(cwd: &str, path: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let rel = rel_path(cwd, path)?;
    let out = std::process::Command::new("git")
        .args(["show", &format!("HEAD:./{rel}")])
        .current_dir(cwd)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_heavy_dirs_and_outside() {
        let root = Path::new(r"C:\p");
        assert!(is_ignored(root, Path::new(r"C:\p\node_modules\x\a.js")));
        assert!(is_ignored(root, Path::new(r"C:\p\.git\index")));
        assert!(is_ignored(root, Path::new(r"C:\p\src-tauri\target\debug\a")));
        assert!(!is_ignored(root, Path::new(r"C:\p\src\target.ts")));
        // 빌드 산출물(Unity 등)·자동 진행 작업 공간
        assert!(is_ignored(root, Path::new(r"C:\p\_Work\proj\Library\Bee\a.dag")));
        assert!(is_ignored(root, Path::new(r"C:\p\Temp\x.tmp")));
        assert!(is_ignored(root, Path::new(r"C:\p\.aith\wt\T-1\a.ts")));
        assert!(!is_ignored(root, Path::new(r"C:\p\Assets\Scripts\Player.cs")));
        assert!(is_ignored(root, Path::new(r"D:\other\a.ts")));
    }

    #[test]
    fn merges_events_per_file() {
        let p = || PathBuf::from(r"C:\p\a");
        let mut b = HashMap::new();
        merge(&mut b, p(), "create");
        merge(&mut b, p(), "modify");
        assert_eq!(b.get(&p()), Some(&"create"));
        merge(&mut b, p(), "remove");
        assert!(b.is_empty());
        merge(&mut b, p(), "remove");
        merge(&mut b, p(), "create");
        assert_eq!(b.get(&p()), Some(&"modify"));
        merge(&mut b, p(), "remove");
        assert_eq!(b.get(&p()), Some(&"remove"));
    }

    #[test]
    fn rel_path_is_case_insensitive_and_bounded() {
        assert_eq!(rel_path(r"C:\Proj", r"c:\proj\src\a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rel_path(r"C:\Proj\", r"C:\Proj\a.ts").as_deref(), Some("a.ts"));
        assert_eq!(rel_path(r"C:\Proj", r"C:\Project\a.ts"), None);
        assert_eq!(rel_path(r"C:\Proj", r"D:\a.ts"), None);
    }

    #[test]
    fn baseline_reads_git_head() {
        let dir = std::env::temp_dir().join(format!("aith-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();

        let cwd = dir.to_string_lossy().to_string();
        let a = dir.join("a.txt").to_string_lossy().to_string();
        let b = dir.join("b.txt").to_string_lossy().to_string();
        assert_eq!(file_baseline(&cwd, &a).unwrap().replace("\r\n", "\n"), "v1\n");
        assert_eq!(file_baseline(&cwd, &b), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
