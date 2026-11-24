// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 저장공간 절약: 에이전트 임시 폴더, 오래 쉰 팀 작업 폴더, 한 번 쓰고 버린 대화 기록을 치운다.
// 언제 돌릴지는 프런트(storageRun)가 정하고, 여기서는 판정과 삭제만 한다.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 레인 id(`tabId~memberId`)를 폴더 이름으로: 영문·숫자·-·_ 아닌 글자는 _
pub fn lane_dir_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// 앱 임시 폴더의 뿌리: %LOCALAPPDATA%\com.aitermhub.app\tmp
fn tmp_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("com.aitermhub.app").join("tmp"))
}

/// 이 레인(에이전트)의 임시 폴더 — 에이전트 프로세스의 TEMP·TMP로 준다. 만들지 못하면 None(그러면 TEMP를 바꾸지 않는다)
pub fn agent_tmp(id: &str) -> Option<PathBuf> {
    let d = tmp_root()?.join(lane_dir_name(id));
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

/// 파일이면 그 수정 시각, 폴더면 안의 가장 늦은 수정 시각(빈 폴더는 폴더 자신의 시각)과 전체 크기
pub(crate) fn newest_and_size(p: &Path) -> (SystemTime, u64) {
    let md = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(_) => return (SystemTime::now(), 0),
    };
    let own = md.modified().unwrap_or_else(|_| SystemTime::now());
    if !md.is_dir() {
        return (own, md.len());
    }
    let (mut newest, mut size, mut any) = (SystemTime::UNIX_EPOCH, 0u64, false);
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                any = true;
                size += m.len();
                if let Ok(t) = m.modified() {
                    newest = newest.max(t);
                }
            }
        }
    }
    (if any { newest } else { own }, size)
}

fn remove_any(p: &Path) -> bool {
    if p.is_dir() { std::fs::remove_dir_all(p).is_ok() } else { std::fs::remove_file(p).is_ok() }
}

fn older_than(t: SystemTime, now: SystemTime, hours: f64) -> bool {
    now.duration_since(t).map(|d| d.as_secs_f64() >= hours * 3600.0).unwrap_or(false)
}

/// 레인 폴더 바로 아래 항목 중 max_hours 넘게 안 바뀐 것을 지운다(skip 레인은 건너뜀). 잠긴 것은 남는다
fn sweep_tmp(root: &Path, max_hours: f64, skip: &[String], now: SystemTime) -> Value {
    let skip: Vec<String> = skip.iter().map(|s| lane_dir_name(s)).collect();
    let (mut n, mut freed) = (0usize, 0u64);
    let Ok(lanes) = std::fs::read_dir(root) else { return json!({ "n": 0, "freed": 0 }) };
    for lane in lanes.flatten() {
        let name = lane.file_name().to_string_lossy().to_string();
        if skip.contains(&name) || !lane.path().is_dir() {
            continue;
        }
        let Ok(items) = std::fs::read_dir(lane.path()) else { continue };
        for it in items.flatten() {
            let (t, size) = newest_and_size(&it.path());
            if older_than(t, now, max_hours) && remove_any(&it.path()) {
                n += 1;
                freed += size;
            }
        }
    }
    json!({ "n": n, "freed": freed })
}

#[tauri::command(async)]
pub fn storage_tmp_sweep(max_hours: f64, skip: Vec<String>) -> Value {
    match tmp_root() {
        Some(r) => sweep_tmp(&r, max_hours, &skip, SystemTime::now()),
        None => json!({ "n": 0, "freed": 0 }),
    }
}

/// 경로들이 있는 드라이브마다 남은 공간(바이트)
#[tauri::command(async)]
pub fn storage_free(paths: Vec<String>) -> Value {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for p in paths {
        let drive = p.chars().take(2).collect::<String>().to_uppercase();
        if drive.len() != 2 || !drive.ends_with(':') || seen.contains(&drive) {
            continue;
        }
        seen.push(drive.clone());
        let root: Vec<u16> = std::ffi::OsStr::new(&format!("{drive}\\")).encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        if unsafe { GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), None, None) }.is_ok() {
            out.push(json!({ "drive": drive, "free": free }));
        }
    }
    Value::Array(out)
}

// ---------- 오래 쉰 팀 작업 폴더 ----------

/// 지워도 다음에 다시 만들어지는 폴더(git이 무시하는 것만 지운다)
const REGEN: [&str; 8] = ["Library", "Temp", "Logs", "obj", "node_modules", ".gradle", "build", "dist"];

#[derive(Debug, PartialEq)]
enum Action {
    Keep,
    /// 폴더를 통째로(브랜치는 남김)
    Remove,
    /// 다시 만들 수 있는 무시된 폴더만
    Trim,
}

/// idle_hours: 마지막 활동에서 지난 시간 · clean: 커밋 안 한 것·합치지 않은 커밋이 없음
fn decide(idle_hours: f64, clean: bool, clean_h: f64, dirty_h: f64) -> Action {
    if clean && idle_hours >= clean_h {
        Action::Remove
    } else if !clean && idle_hours >= dirty_h {
        Action::Trim
    } else {
        Action::Keep
    }
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Codex 기록의 작업 폴더(정규화) → 그 폴더 기록 중 가장 늦은 수정 시각
fn codex_activity() -> std::collections::HashMap<String, SystemTime> {
    let mut map = std::collections::HashMap::new();
    for p in codex_files(&codex_root()) {
        let Some(meta) = first_meta(&p) else { continue };
        let Some(cwd) = meta.get("cwd").and_then(|v| v.as_str()) else { continue };
        let Ok(t) = std::fs::metadata(&p).and_then(|m| m.modified()) else { continue };
        let e = map.entry(norm(cwd)).or_insert(t);
        if t > *e {
            *e = t;
        }
    }
    map
}

/// 이 폴더의 Claude 대화(jsonl) 중 가장 늦은 수정 시각 — 프로젝트 폴더 이름은 대소문자를 가리지 않고 찾는다
fn claude_activity(cwd: &str) -> Option<SystemTime> {
    let want = crate::util::claude_project_dir(cwd);
    let name = want.file_name()?.to_string_lossy().to_lowercase();
    let dir = std::fs::read_dir(want.parent()?).ok()?.flatten().find(|e| e.file_name().to_string_lossy().to_lowercase() == name)?.path();
    std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).filter_map(|e| e.metadata().ok()?.modified().ok()).max()
}

/// 커밋 안 한 변경·추적 안 하는 파일이 없고(무시된 파일 제외, 사용자 git 설정과 관계없이), 원래 브랜치에 없는 작업 커밋이 없다.
/// 브랜치에서 떨어진 HEAD(detached)나 하다 만 rebase·merge·bisect·cherry-pick이면 깨끗하지 않다(지우면 그 커밋·상태를 잃는다).
/// 일을 받을 때 맞추면서 생긴 합치기 커밋(merge)은 작업이 아니므로 세지 않는다
fn is_clean(repo: &Path, wt: &Path) -> bool {
    let g = |args: &[&str]| crate::teamwt::git(wt, args);
    let Ok(st) = g(&["-c", "core.untrackedCache=false", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]) else { return false };
    if !st.trim().is_empty() || g(&["symbolic-ref", "-q", "HEAD"]).is_err() {
        return false;
    }
    let Ok(gd) = g(&["rev-parse", "--absolute-git-dir"]) else { return false };
    let gd = PathBuf::from(gd.trim());
    if ["rebase-merge", "rebase-apply", "MERGE_HEAD", "BISECT_LOG", "CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|x| gd.join(x).exists()) {
        return false;
    }
    let Ok(base) = crate::teamwt::current_branch(repo) else { return false };
    g(&["rev-list", "--count", "--no-merges", &format!("{base}..HEAD")]).map(|n| n.trim() == "0").unwrap_or(false)
}

/// 앱이 이 폴더를 만들거나 맞춘 시각(teamwt::touch_active)
fn active_marker(wt: &Path) -> Option<SystemTime> {
    let gd = crate::teamwt::git(wt, &["rev-parse", "--absolute-git-dir"]).ok()?;
    std::fs::metadata(Path::new(gd.trim()).join("aith-active")).ok()?.modified().ok()
}

fn last_commit(wt: &Path) -> Option<SystemTime> {
    let s = crate::teamwt::git(wt, &["log", "-1", "--format=%ct"]).ok()?;
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(s.trim().parse().ok()?))
}

/// 무시된 파일 중 REGEN 이름의 폴더들(작업 폴더 기준 상대 경로)
fn regen_dirs(wt: &Path) -> Vec<String> {
    let Ok(out) = crate::teamwt::git(wt, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]) else { return vec![] };
    out.lines()
        .map(|l| l.trim().trim_end_matches('/').to_string())
        .filter(|l| l.rsplit('/').next().is_some_and(|last| REGEN.contains(&last)))
        .collect()
}

/// 지울 폴더를 옮겨 둘 이름(같은 폴더 안, 겹치면 번호를 붙인다)
fn trash_path(p: &Path) -> PathBuf {
    let base = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    (0..100).map(|i| p.with_file_name(format!("{base}.trash-{}-{i}", std::process::id()))).find(|t| !t.exists()).unwrap_or_else(|| p.with_file_name(format!("{base}.trash-x")))
}

/// 폴더를 통째로 지운다. 먼저 이름을 바꿔 본다 — 안의 파일을 누가 열고 있으면 Windows가 막아서, 반쯤 지워진 작업 폴더가 남지 않는다
fn remove_wt(repo: &Path, wt: &Path) -> Result<u64, String> {
    let trash = trash_path(wt);
    std::fs::rename(wt, &trash).map_err(|_| "사용 중".to_string())?;
    let (_, size) = newest_and_size(&trash);
    let _ = std::fs::remove_dir_all(&trash);
    let _ = crate::teamwt::git(repo, &["worktree", "prune"]);
    Ok(size)
}

/// repos 안의 `.aith/wt/t-*` 하나하나를 판정해 지우거나 비운다. skip: 건드리면 안 되는 작업 폴더(일하는 중·프로세스가 떠 있음)
fn sweep_wt(repos: &[String], skip: &[String], clean_h: f64, dirty_h: f64, now: SystemTime) -> Value {
    let skip: Vec<String> = skip.iter().map(|s| norm(s)).collect();
    let mut codex: Option<std::collections::HashMap<String, SystemTime>> = None; // 필요할 때 한 번만 읽는다(기록이 많다)
    let idle_of = |t: SystemTime| now.duration_since(t).map(|d| d.as_secs_f64() / 3600.0).unwrap_or(0.0);
    let (mut removed, mut trimmed, mut skipped) = (vec![], vec![], vec![]);
    for r in repos {
        let repo = Path::new(r);
        let Ok(rd) = std::fs::read_dir(repo.join(".aith").join("wt")) else { continue };
        for e in rd.flatten() {
            let wt = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            // 전에 다 못 지운 것(잠겨 있던 파일)은 다시 지워 본다
            if name.contains(".trash-") {
                let _ = std::fs::remove_dir_all(&wt);
                continue;
            }
            if !name.starts_with("t-") || !wt.join(".git").exists() {
                continue;
            }
            let path = wt.to_string_lossy().to_string();
            if skip.contains(&norm(&path)) {
                skipped.push(json!({ "path": path, "why": "일하는 중" }));
                continue;
            }
            // 팀 탭이 이 폴더를 만들거나 맞추는 중이면 끝날 때까지 기다린다(그 사이 지워 일을 보낼 폴더가 사라지지 않게)
            let _g = crate::teamwt::WT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let mut last = [claude_activity(&path), last_commit(&wt), active_marker(&wt)].into_iter().flatten().max().unwrap_or(SystemTime::UNIX_EPOCH);
            if idle_of(last) < clean_h.min(dirty_h) {
                continue;
            }
            let map = codex.get_or_insert_with(codex_activity);
            if let Some(t) = map.get(&norm(&path)) {
                last = last.max(*t);
            }
            match decide(idle_of(last), is_clean(repo, &wt), clean_h, dirty_h) {
                Action::Keep => {}
                Action::Remove => match remove_wt(repo, &wt) {
                    Ok(freed) => removed.push(json!({ "path": path, "freed": freed })),
                    Err(why) => skipped.push(json!({ "path": path, "why": why })),
                },
                Action::Trim => {
                    let (mut freed, mut dirs) = (0u64, vec![]);
                    for d in regen_dirs(&wt) {
                        // 먼저 옮겨 본다 — 열려 있는 Unity 등이 쓰고 있으면 옮기지 못해 그대로 둔다(반쯤 지운 캐시가 남지 않게)
                        let p = wt.join(&d);
                        let t = trash_path(&p);
                        if std::fs::rename(&p, &t).is_err() {
                            continue;
                        }
                        freed += newest_and_size(&t).1;
                        let _ = std::fs::remove_dir_all(&t);
                        dirs.push(d);
                    }
                    if !dirs.is_empty() {
                        trimmed.push(json!({ "path": path, "freed": freed, "dirs": dirs }));
                    }
                }
            }
        }
    }
    json!({ "removed": removed, "trimmed": trimmed, "skipped": skipped })
}

#[tauri::command(async)]
pub fn storage_wt_sweep(repos: Vec<String>, skip: Vec<String>, clean_hours: f64, dirty_hours: f64) -> Value {
    sweep_wt(&repos, &skip, clean_hours, dirty_hours, SystemTime::now())
}

// ---------- Codex 기록 읽기 ----------

fn codex_root() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".codex")).join("sessions")
}

/// sessions/년/월/일/*.jsonl
fn codex_files(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && depth < 3 {
                stack.push((p, depth + 1));
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

/// 첫 줄(session_meta)의 payload
fn first_meta(p: &Path) -> Option<Value> {
    use std::io::BufRead;
    let f = std::fs::File::open(p).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(f).read_line(&mut line).ok()?;
    serde_json::from_str::<Value>(&line).ok()?.get("payload").cloned()
}

// ---------- 한 번 쓰고 버린 대화 기록 ----------

fn meta_id(meta: &Value) -> Option<String> {
    meta.get("id").and_then(|v| v.as_str()).map(String::from)
}

fn meta_parent(meta: &Value) -> Option<String> {
    ["parent_thread_id", "forked_from_id"].iter().find_map(|k| meta.get(*k).and_then(|v| v.as_str()).map(String::from))
}

/// Codex 기록 첫 줄에서 정리에 필요한 것만(첫 줄에는 지시문 전체가 들어 있어 수십 KB라 통째로 들고 있지 않는다)
struct Lite {
    id: Option<String>,
    parent: Option<String>,
    exec: bool,
    cwd: String,
}

fn lite(p: &Path) -> Option<Lite> {
    let m = first_meta(p)?;
    Some(Lite {
        id: meta_id(&m),
        parent: meta_parent(&m),
        exec: m.get("originator").and_then(|v| v.as_str()) == Some("codex_exec"),
        cwd: m.get("cwd").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    })
}

/// Codex: 에이전트가 한 번씩 부른 기록(`codex_exec`) 중 앱이 만든 대화(owned)·지킬 id(keep)와 그 부모 사슬이 아니고 max_hours 넘게 안 바뀐 것을 지운다.
/// git 저장소나 팀 작업 폴더 바로 그곳(`.git`이 있는 폴더)에서 돈 기록은 앱 탭의 대화일 수 있어 남긴다 —
/// 에이전트가 그림 생성 등으로 부른 기록은 하위 폴더(art_src, Temp/…)에서 돈다
fn sweep_codex(root: &Path, owned: &std::collections::HashSet<String>, keep: &[String], max_hours: f64, now: SystemTime) -> (usize, u64) {
    let files: Vec<(PathBuf, Lite)> = codex_files(root).into_iter().filter_map(|p| lite(&p).map(|m| (p, m))).collect();
    let parent: std::collections::HashMap<&str, &str> = files.iter().filter_map(|(_, m)| Some((m.id.as_deref()?, m.parent.as_deref()?))).collect();
    let mut guard: std::collections::HashSet<String> = owned.iter().cloned().chain(keep.iter().cloned()).collect();
    for id in guard.clone() {
        let mut cur = parent.get(id.as_str()).copied();
        while let Some(p) = cur {
            if !guard.insert(p.to_string()) {
                break;
            }
            cur = parent.get(p).copied();
        }
    }
    let (mut n, mut freed) = (0, 0);
    for (p, m) in &files {
        if !m.exec || m.id.as_ref().is_some_and(|id| guard.contains(id)) || (!m.cwd.is_empty() && Path::new(&m.cwd).join(".git").exists()) {
            continue;
        }
        let Ok(md) = std::fs::metadata(p) else { continue };
        if md.modified().is_ok_and(|t| older_than(t, now, max_hours)) && std::fs::remove_file(p).is_ok() {
            n += 1;
            freed += md.len();
        }
    }
    (n, freed)
}

/// 처음 한 번: 기존 기록 중 앱이 만든 것으로 볼 대화 — 작업 폴더가 앱이 아는 프로젝트 폴더나 그 팀 작업 폴더(`.aith/wt/<이름>`) 바로 그곳인 `codex_exec` 기록 + keep
fn seed_owned(root: &Path, roots: &[String], keep: &[String]) -> std::collections::HashSet<String> {
    let roots: Vec<String> = roots.iter().map(|r| norm(r)).collect();
    let mine = |cwd: &str| {
        let c = norm(cwd);
        roots.iter().any(|r| c == *r || c.strip_prefix(&format!("{r}/.aith/wt/")).is_some_and(|rest| !rest.is_empty() && !rest.contains('/')))
    };
    let mut out: std::collections::HashSet<String> = keep.iter().cloned().collect();
    for p in codex_files(root) {
        let Some(m) = first_meta(&p) else { continue };
        if m.get("originator").and_then(|v| v.as_str()) == Some("codex_exec") && m.get("cwd").and_then(|v| v.as_str()).is_some_and(mine) {
            if let Some(id) = meta_id(&m) {
                out.insert(id);
            }
        }
    }
    out
}

/// Claude: 팀 작업 폴더(`-aith-wt-`) 대화 중 keep이 아니고 max_days 넘게 안 쓴 것. 폴더마다 가장 최근 대화와 memory는 남긴다
fn sweep_claude(projects: &Path, keep: &[String], max_days: f64, now: SystemTime) -> (usize, u64) {
    let (mut n, mut freed) = (0, 0);
    let Ok(rd) = std::fs::read_dir(projects) else { return (0, 0) };
    for d in rd.flatten() {
        if !d.file_name().to_string_lossy().contains("-aith-wt-") {
            continue;
        }
        let Ok(items) = std::fs::read_dir(d.path()) else { continue };
        let mut convs: Vec<(SystemTime, PathBuf)> = items
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        convs.sort_by(|a, b| b.0.cmp(&a.0));
        for (t, p) in convs.into_iter().skip(1) {
            let id = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if keep.contains(&id) || !older_than(t, now, max_days * 24.0) {
                continue;
            }
            let side = p.with_extension("");
            let size = newest_and_size(&p).1 + if side.is_dir() { newest_and_size(&side).1 } else { 0 };
            if std::fs::remove_file(&p).is_ok() {
                if side.is_dir() {
                    let _ = std::fs::remove_dir_all(&side);
                }
                n += 1;
                freed += size;
            }
        }
    }
    (n, freed)
}

/// 앱이 만든 Codex 대화 목록: %APPDATA%\com.aitermhub.app\codex_owned.json
fn owned_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("com.aitermhub.app").join("codex_owned.json"))
}

fn read_owned() -> Option<std::collections::HashSet<String>> {
    let s = std::fs::read_to_string(owned_path()?).ok()?;
    serde_json::from_str::<Vec<String>>(&s).ok().map(|v| v.into_iter().collect())
}

fn write_owned(set: &std::collections::HashSet<String>) {
    if let Some(p) = owned_path() {
        let mut v: Vec<&String> = set.iter().collect();
        v.sort();
        // 쓰다 꺼져도 목록이 깨지지 않게 임시 파일에 쓰고 바꾼다
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_string(&v).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

static OWNED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Codex 탭·팀원의 대화 id가 정해질 때마다 앱이 넣는다(일회용 기록으로 지우지 않게)
#[tauri::command(async)]
pub fn storage_codex_own(ids: Vec<String>) {
    let _g = OWNED_LOCK.lock();
    let Some(mut set) = read_owned() else { return }; // 아직 첫 채우기 전이면 그때 함께 들어간다(keep으로)
    let before = set.len();
    set.extend(ids.into_iter().filter(|s| !s.is_empty()));
    if set.len() != before {
        write_owned(&set);
    }
}

/// keep: 지금 탭·팀원·최근 닫은 팀이 가리키는 대화 id · roots: 앱이 아는 프로젝트 폴더
#[tauri::command(async)]
pub fn storage_logs_sweep(keep: Vec<String>, roots: Vec<String>, codex_hours: f64, claude_days: f64) -> Value {
    let now = SystemTime::now();
    let owned = {
        let _g = OWNED_LOCK.lock();
        match read_owned() {
            Some(s) => s,
            None => {
                let s = seed_owned(&codex_root(), &roots, &keep);
                write_owned(&s);
                s
            }
        }
    };
    let (cn, cf) = sweep_codex(&codex_root(), &owned, &keep, codex_hours, now);
    let projects = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude").join("projects");
    let (ln, lf) = sweep_claude(&projects, &keep, claude_days, now);
    json!({ "codex": { "n": cn, "freed": cf }, "claude": { "n": ln, "freed": lf } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aith-stor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write_aged(p: &Path, hours_ago: u64) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
        let t = SystemTime::now() - Duration::from_secs(hours_ago * 3600);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn sanitizes_lane_id() {
        assert_eq!(lane_dir_name("t1~m5"), "t1_m5");
        assert_eq!(lane_dir_name("../x"), "___x");
    }

    #[test]
    fn sweep_removes_only_old_and_unskipped() {
        let root = tmp("sweep");
        write_aged(&root.join("a/old.txt"), 7);
        write_aged(&root.join("a/new.txt"), 0);
        write_aged(&root.join("a/olddir/f.txt"), 7);
        write_aged(&root.join("b/old.txt"), 7);
        let r = sweep_tmp(&root, 6.0, &["b".to_string()], SystemTime::now());
        assert!(!root.join("a/old.txt").exists());
        assert!(!root.join("a/olddir").exists());
        assert!(root.join("a/new.txt").exists());
        assert!(root.join("b/old.txt").exists());
        assert_eq!(r["n"], 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- 팀 작업 폴더 ----
    fn repo(name: &str) -> PathBuf {
        let d = tmp(name);
        std::fs::write(d.join("a.txt"), "1
").unwrap();
        std::fs::write(d.join(".gitignore"), "Library/
").unwrap();
        crate::teamwt::init(&d).unwrap();
        d
    }
    fn sweep(d: &Path, skip: &[String], clean_h: f64, dirty_h: f64) -> Value {
        sweep_wt(&[d.to_string_lossy().to_string()], skip, clean_h, dirty_h, SystemTime::now())
    }

    #[test]
    fn decide_by_idle_and_clean() {
        assert_eq!(decide(7.0, true, 6.0, 24.0), Action::Remove);
        assert_eq!(decide(5.0, true, 6.0, 24.0), Action::Keep);
        assert_eq!(decide(7.0, false, 6.0, 24.0), Action::Keep);
        assert_eq!(decide(25.0, false, 6.0, 24.0), Action::Trim);
    }

    #[test]
    fn removes_clean_idle_worktree() {
        let d = repo("wtclean");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        std::fs::write(w.join("b.txt"), "m1
").unwrap();
        crate::teamwt::merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        let r = sweep(&d, &[], 0.0, 24.0);
        assert_eq!(r["removed"].as_array().unwrap().len(), 1, "{r}");
        assert!(!w.exists());
        // 브랜치는 남고, 같은 경로에 다시 만들 수 있다
        let again = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        assert_eq!(again, w);
        assert!(w.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_uncommitted() {
        let d = repo("wtdirty");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        std::fs::write(w.join("notes.md"), "미커밋
").unwrap();
        std::fs::create_dir_all(w.join("Library")).unwrap();
        std::fs::write(w.join("Library/cache.bin"), "c").unwrap();
        let r = sweep(&d, &[], 0.0, 24.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert!(w.join("Library").exists());
        let r = sweep(&d, &[], 0.0, 0.0);
        assert_eq!(r["trimmed"].as_array().unwrap().len(), 1, "{r}");
        assert!(!w.join("Library").exists());
        assert!(w.join("notes.md").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_unmerged_commits() {
        let d = repo("wtunmerged");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        std::fs::write(w.join("c.txt"), "x
").unwrap();
        for a in [&["add", "-A"][..], &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c"][..]] {
            assert!(std::process::Command::new("git").args(a).current_dir(&w).status().unwrap().success());
        }
        let r = sweep(&d, &[], 0.0, 24.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert!(w.join("c.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn skips_live() {
        let d = repo("wtlive");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        let r = sweep(&d, &[w.to_string_lossy().to_string()], 0.0, 0.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert_eq!(r["skipped"][0]["why"], "일하는 중");
        assert!(w.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recent_activity_wins() {
        let d = repo("wtrecent");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        let r = sweep(&d, &[], 6.0, 24.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert!(w.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---- 대화 기록 ----
    fn codex_rec(root: &Path, id: &str, originator: &str, cwd: &str, parent: Option<&str>, hours_ago: u64) -> PathBuf {
        let p = root.join("2026/11/15").join(format!("rollout-x-{id}.jsonl"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut pl = json!({ "id": id, "cwd": cwd, "originator": originator });
        if let Some(par) = parent { pl["parent_thread_id"] = json!(par); }
        std::fs::write(&p, format!("{}
", json!({ "type": "session_meta", "payload": pl }))).unwrap();
        let t = SystemTime::now() - Duration::from_secs(hours_ago * 3600);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        p
    }
    fn set(v: &[&str]) -> std::collections::HashSet<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn deletes_old_exec_not_owned() {
        let r = tmp("cx1");
        let a = codex_rec(&r, "A", "codex_exec", "C:/P/art_src", None, 7);
        let b = codex_rec(&r, "B", "codex_exec", "C:/P/art_src", None, 1);
        let (n, _) = sweep_codex(&r, &set(&[]), &[], 6.0, SystemTime::now());
        assert_eq!(n, 1);
        assert!(!a.exists() && b.exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn keeps_tui() {
        let r = tmp("cx2");
        let a = codex_rec(&r, "A", "codex-tui", "C:/P", None, 70);
        sweep_codex(&r, &set(&[]), &[], 6.0, SystemTime::now());
        assert!(a.exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn keeps_owned_and_parents() {
        let r = tmp("cx3");
        let p = codex_rec(&r, "P", "codex_exec", "C:/P", None, 70);
        let c = codex_rec(&r, "C", "codex_exec", "C:/P", Some("P"), 70);
        let k = codex_rec(&r, "K", "codex_exec", "C:/P", None, 70);
        let x = codex_rec(&r, "X", "codex_exec", "C:/P", None, 70);
        let (n, _) = sweep_codex(&r, &set(&["C"]), &["K".to_string()], 6.0, SystemTime::now());
        assert_eq!(n, 1);
        assert!(p.exists() && c.exists() && k.exists() && !x.exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn seed_owns_root_cwd() {
        let r = tmp("cx4");
        codex_rec(&r, "R", "codex_exec", r"C:\P", None, 70);
        codex_rec(&r, "W", "codex_exec", "c:/p/.aith/wt/t-t1-m1", None, 70);
        codex_rec(&r, "S", "codex_exec", "C:/P/art_src", None, 70);
        let owned = seed_owned(&r, &["C:/P".to_string()], &["Z".to_string()]);
        assert!(owned.contains("R") && owned.contains("W") && owned.contains("Z"));
        assert!(!owned.contains("S"));
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn keeps_newest_per_folder() {
        let r = tmp("cl1");
        let d = r.join("C--P--aith-wt-t-t1-m1");
        write_aged(&d.join("old.jsonl"), 24 * 20);
        write_aged(&d.join("old/subagents/x.jsonl"), 24 * 20);
        write_aged(&d.join("newer.jsonl"), 24 * 18);
        write_aged(&d.join("memory/MEMORY.md"), 24 * 30);
        let (n, _) = sweep_claude(&r, &[], 14.0, SystemTime::now());
        assert_eq!(n, 1);
        assert!(!d.join("old.jsonl").exists() && !d.join("old").exists());
        assert!(d.join("newer.jsonl").exists() && d.join("memory/MEMORY.md").exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn skips_non_team_claude() {
        let r = tmp("cl2");
        write_aged(&r.join("C--P/a.jsonl"), 24 * 20);
        write_aged(&r.join("C--P/b.jsonl"), 24 * 20);
        let (n, _) = sweep_claude(&r, &[], 14.0, SystemTime::now());
        assert_eq!(n, 0);
        assert!(r.join("C--P/a.jsonl").exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn keeps_claude_keep_ids() {
        let r = tmp("cl3");
        let d = r.join("C--P--aith-wt-t-t1-m2");
        write_aged(&d.join("keepme.jsonl"), 24 * 20);
        write_aged(&d.join("newest.jsonl"), 24 * 15);
        let (n, _) = sweep_claude(&r, &["keepme".to_string()], 14.0, SystemTime::now());
        assert_eq!(n, 0);
        let _ = std::fs::remove_dir_all(&r);
    }

    // ---- 검토 뒤 고친 것 ----
    fn git_in(dir: &Path, args: &[&str]) {
        let mut a = vec!["-c", "user.email=t@t", "-c", "user.name=t"];
        a.extend_from_slice(args);
        assert!(std::process::Command::new("git").args(&a).current_dir(dir).status().unwrap().success(), "{args:?}");
    }

    #[test]
    fn detached_head_commit_is_not_clean() {
        let d = repo("wtdetached");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        git_in(&w, &["checkout", "-q", "--detach"]);
        std::fs::write(w.join("fix.txt"), "x\n").unwrap();
        git_in(&w, &["add", "-A"]);
        git_in(&w, &["commit", "-q", "-m", "detached fix"]);
        let r = sweep(&d, &[], 0.0, 24.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert!(w.join("fix.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn untracked_hidden_by_config_is_not_clean() {
        let d = repo("wtuntracked");
        git_in(&d, &["config", "status.showUntrackedFiles", "no"]);
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        std::fs::write(w.join("new.cs"), "class N {}\n").unwrap();
        let r = sweep(&d, &[], 0.0, 24.0);
        assert!(r["removed"].as_array().unwrap().is_empty(), "{r}");
        assert!(w.join("new.cs").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sync_merge_commit_still_counts_as_clean() {
        let d = repo("wtsynced");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        // 원래 브랜치가 앞서 나가고, 일을 받을 때 맞추면 팀원 브랜치에 합치기 커밋만 생긴다
        std::fs::write(d.join("base.txt"), "b\n").unwrap();
        git_in(&d, &["add", "-A"]);
        git_in(&d, &["commit", "-q", "-m", "base moves"]);
        std::fs::write(d.join("base2.txt"), "b\n").unwrap();
        git_in(&d, &["add", "-A"]);
        git_in(&d, &["commit", "-q", "-m", "base moves again"]);
        std::fs::write(w.join("mine.txt"), "m\n").unwrap();
        git_in(&w, &["add", "-A"]);
        git_in(&w, &["commit", "-q", "-m", "member work"]);
        crate::teamwt::merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        std::fs::write(d.join("base3.txt"), "b\n").unwrap();
        git_in(&d, &["add", "-A"]);
        git_in(&d, &["commit", "-q", "-m", "base moves after merge"]);
        crate::teamwt::sync(&d, "t1", "m1").unwrap();
        let r = sweep(&d, &[], 0.0, 24.0);
        assert_eq!(r["removed"].as_array().unwrap().len(), 1, "{r}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sync_marks_activity() {
        let d = repo("wtmark");
        let w = crate::teamwt::worktree(&d, "t1", "m1").unwrap();
        crate::teamwt::sync(&d, "t1", "m1").unwrap();
        let t = active_marker(&w).expect("표시가 남아야 한다");
        assert!(SystemTime::now().duration_since(t).unwrap().as_secs() < 60);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_exec_run_at_git_root() {
        let r = tmp("cx5");
        let proj = tmp("cx5proj");
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let a = codex_rec(&r, "A", "codex_exec", &proj.to_string_lossy(), None, 70);
        let b = codex_rec(&r, "B", "codex_exec", &proj.join("art_src").to_string_lossy(), None, 70);
        sweep_codex(&r, &set(&[]), &[], 6.0, SystemTime::now());
        assert!(a.exists(), "프로젝트·작업 폴더 바로 그곳에서 돈 기록은 앱 탭의 대화일 수 있어 남긴다");
        assert!(!b.exists());
        let _ = std::fs::remove_dir_all(&r);
        let _ = std::fs::remove_dir_all(&proj);
    }
}
