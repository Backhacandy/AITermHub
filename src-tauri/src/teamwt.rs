// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 팀 워크트리: 일하는 에이전트마다 자기 git 브랜치(`aith/team-<팀>/<에이전트>`)와 작업 폴더(`.aith/wt/t-<팀>-<에이전트>`).
//! 요청이 끝나면 원래 폴더의 지금 브랜치에 합치고(더러우면 기다림, 충돌이면 되돌림), 다른 에이전트 브랜치를 맞춘다.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

const NO_WINDOW: u32 = 0x0800_0000;
/// 앱이 만드는 커밋의 신원 — 사용자 서명 설정(commit.gpgsign)은 따르지 않는다(창이 뜨거나 실패하지 않게)
const ID: [&str; 6] = ["-c", "user.email=aith@local", "-c", "user.name=팀", "-c", "commit.gpgsign=false"];

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("git {} 실패: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// 신원을 붙여 git 실행(커밋·합치기)
fn git_id(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut a: Vec<&str> = ID.to_vec();
    a.extend_from_slice(args);
    git(dir, &a)
}

fn branch(team: &str, member: &str) -> String {
    format!("aith/team-{team}/{member}")
}

/// 이 팀원의 브랜치가 있는지 — 작업 폴더가 정리로 지워졌어도 브랜치가 있으면 다음 일 때 같은 경로에 다시 만든다
pub fn branch_exists(repo: &Path, team: &str, member: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch(team, member))]).is_ok()
}

/// 작업 폴더를 만들거나 맞추는 동안 저장공간 정리(storage.rs)가 그 폴더를 지우지 않게
pub(crate) static WT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 앱이 이 작업 폴더를 막 썼다는 표시(git 폴더 안이라 작업 내용·git status에 안 보인다) — 정리가 쉰 시간을 잴 때 본다
pub(crate) fn touch_active(dir: &Path) {
    if let Ok(gd) = git(dir, &["rev-parse", "--absolute-git-dir"]) {
        let _ = std::fs::write(Path::new(gd.trim()).join("aith-active"), "");
    }
}

fn wt_path(repo: &Path, team: &str, member: &str) -> PathBuf {
    repo.join(".aith").join("wt").join(format!("t-{team}-{member}"))
}

/// 팀·에이전트 id는 브랜치·폴더 이름에 들어가므로 영문·숫자·-·_만
fn safe(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err(format!("잘못된 id: {id}"))
    }
}

/// 프로젝트 종류: Unity(Assets + ProjectSettings) · Unreal(*.uproject) · 그 밖
pub fn kind(repo: &Path) -> &'static str {
    if repo.join("Assets").is_dir() && repo.join("ProjectSettings").is_dir() {
        return "unity";
    }
    let unreal = std::fs::read_dir(repo)
        .map(|rd| rd.flatten().any(|e| e.path().extension().map(|x| x == "uproject").unwrap_or(false)))
        .unwrap_or(false);
    if unreal {
        "unreal"
    } else {
        "other"
    }
}

fn ignore_for(kind: &str) -> &'static str {
    match kind {
        "unity" => "Library/\nTemp/\nObj/\nobj/\nBuild/\nBuilds/\nLogs/\nUserSettings/\nMemoryCaptures/\n*.csproj\n*.sln\n*.user\n.vs/\n",
        "unreal" => "Binaries/\nDerivedDataCache/\nIntermediate/\nSaved/\n.vs/\n*.sln\n",
        _ => "node_modules/\ntarget/\ndist/\nbuild/\n.venv/\n__pycache__/\n",
    }
}

/// 커밋 안 한 변경이 있는지(`.aith/` 안은 뺌)
/// 이미 있는(추적 중인) 파일을 직접 고친 것 — 합치기 전에 기다릴 이유.
/// 새 파일(??, 테스트 결과물 등)은 넣지 않는다: git 합치기에 걸리지 않고, 정말 겹치면 git이 거부해 되돌린다. `.aith/`도 뺀다
fn dirty_files(repo: &Path) -> Vec<String> {
    git(repo, &["status", "--porcelain"])
        .map(|s| {
            s.lines()
                .filter(|l| l.len() > 3 && !l.starts_with("??"))
                .map(|l| l[3..].trim_matches('"').to_string())
                .filter(|f| !f.starts_with(".aith/"))
                .collect()
        })
        .unwrap_or_default()
}

fn dirty(repo: &Path) -> bool {
    !dirty_files(repo).is_empty()
}

pub(crate) fn current_branch(repo: &Path) -> Result<String, String> {
    let b = git(repo, &["branch", "--show-current"])?.trim().to_string();
    if b.is_empty() {
        Err("원래 폴더가 브랜치가 아닌 상태(detached HEAD)라 합칠 수 없어요".into())
    } else {
        Ok(b)
    }
}

pub fn repo_state(repo: &Path) -> Value {
    let is_git = git(repo, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true").unwrap_or(false);
    let has_commit = is_git && git(repo, &["rev-parse", "--verify", "HEAD"]).is_ok();
    json!({
        // 저장소 루트가 아닌 하위 폴더면 그 경로("pkg/app/") — 브랜치 모드는 루트에서만
        "prefix": if is_git { git(repo, &["rev-parse", "--show-prefix"]).map(|s| s.trim().to_string()).unwrap_or_default() } else { String::new() },
        "is_git": is_git,
        "has_commit": has_commit,
        "dirty": is_git && dirty(repo),
        "branch": git(repo, &["branch", "--show-current"]).map(|s| s.trim().to_string()).unwrap_or_default(),
    })
}

/// git 저장소 만들기: init(필요하면) · .gitignore(없을 때 종류별) · .aith 제외 · 첫 커밋
pub fn init(repo: &Path) -> Result<(), String> {
    if !git(repo, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true").unwrap_or(false) {
        git(repo, &["init", "-q"])?;
    }
    let gi = repo.join(".gitignore");
    if !gi.exists() {
        std::fs::write(&gi, ignore_for(kind(repo))).map_err(|e| e.to_string())?;
    }
    crate::collab::exclude_aith(repo)?;
    if git(repo, &["rev-parse", "--verify", "HEAD"]).is_err() {
        git(repo, &["add", "-A"])?;
        git_id(repo, &["commit", "-q", "--allow-empty", "-m", "팀: 시작"])?;
    }
    Ok(())
}

/// 에이전트 워크트리(있으면 그 경로, 없으면 원래 폴더의 지금 HEAD에서 브랜치와 함께 만든다)
pub fn worktree(repo: &Path, team: &str, member: &str) -> Result<PathBuf, String> {
    safe(team)?;
    safe(member)?;
    let dir = wt_path(repo, team, member);
    let _g = WT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if dir.join(".git").exists() {
        touch_active(&dir);
        return Ok(dir);
    }
    crate::collab::exclude_aith(repo)?;
    let _ = git(repo, &["worktree", "prune"]);
    let b = branch(team, member);
    let path = dir.to_string_lossy().to_string();
    if git(repo, &["rev-parse", "--verify", &b]).is_ok() {
        git(repo, &["worktree", "add", &path, &b])?;
    } else {
        git(repo, &["worktree", "add", "-b", &b, &path, "HEAD"])?;
    }
    touch_active(&dir);
    Ok(dir)
}

/// 워크트리의 커밋 안 한 변경을 커밋(없으면 그대로). 사용자 훅(pre-commit 등)은 돌리지 않는다.
/// 충돌을 덜 푼 파일·충돌 표시(<<<<<<<)가 있으면 커밋하지 않는다 — 그대로 사용자 브랜치로 합쳐지지 않게
fn commit_wt(dir: &Path, message: &str) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let unmerged = conflicted(dir);
    if !unmerged.is_empty() {
        return Err(format!("충돌 표시가 남아 있어 커밋하지 않았어요: {}", unmerged.join(", ")));
    }
    git(dir, &["add", "-A"])?;
    if git(dir, &["diff", "--cached", "--name-only"])?.trim().is_empty() {
        return Ok(());
    }
    let staged = git(dir, &["diff", "--cached", "-U0", "--no-color"])?;
    let mut bad: Vec<String> = Vec::new();
    let mut file = String::new();
    for l in staged.lines() {
        if let Some(f) = l.strip_prefix("+++ b/") {
            file = f.to_string();
        } else if l.starts_with("+<<<<<<< ") || l.starts_with("+>>>>>>> ") || l == "+=======" {
            if !bad.contains(&file) {
                bad.push(file.clone());
            }
        }
    }
    if !bad.is_empty() {
        let _ = git(dir, &["reset", "-q"]);
        return Err(format!("충돌 표시가 남아 있어 커밋하지 않았어요: {}", bad.join(", ")));
    }
    git_id(dir, &["commit", "-q", "--no-verify", "-m", message])?;
    Ok(())
}

fn conflicted(dir: &Path) -> Vec<String> {
    git(dir, &["diff", "--name-only", "--diff-filter=U"])
        .map(|s| s.lines().map(|l| l.trim().replace('\\', "/")).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// 공유 저장소: 에이전트 브랜치를 커밋 하나로 묶어 사용자 이름으로 넣는다(검사·서명은 그 저장소 설정대로).
/// 넣었으면 Ok(true), 이미 들어가 있어 넣을 게 없으면 Ok(false)
fn squash_one(repo: &Path, b: &str, message: &str) -> Result<bool, String> {
    // --ff: 저장소에 merge.ff=false(또는 only)가 있어도 --squash와 부딪치지 않게
    git(repo, &["merge", "--squash", "--ff", b])?;
    if git(repo, &["diff", "--cached", "--quiet"]).is_ok() {
        let _ = git(repo, &["reset", "-q"]);
        return Ok(false);
    }
    git(repo, &["commit", "-q", "-m", message])?;
    Ok(true)
}

/// 에이전트 브랜치들을 원래 폴더의 지금 브랜치에 합친다.
/// shared(남의 저장소): 에이전트마다 커밋 하나로 묶고(제목은 message 그대로), 사용자 이름·검사(hook)·서명 설정을 지킨다
/// stash: 원래 폴더에서 고친 파일이 합칠 내용과 겹치면 그 변경을 git stash로 보관한 뒤 합친다(지우지 않는다)
pub fn merge(repo: &Path, team: &str, members: &[String], message: &str, shared: bool, stash: bool) -> Result<Value, String> {
    safe(team)?;
    for m in members {
        safe(m)?;
    }
    let base = current_branch(repo)?;
    let (mut merged, mut nothing, mut conflicts, mut failed) = (vec![], vec![], vec![], vec![]);
    // 1) 에이전트 작업 폴더를 먼저 저장해 합칠 내용을 정한다
    let mut todo: Vec<(String, String)> = vec![];
    for m in members {
        let b = branch(team, m);
        if git(repo, &["rev-parse", "--verify", &b]).is_err() {
            nothing.push(m.clone());
            continue;
        }
        if let Err(e) = commit_wt(&wt_path(repo, team, m), message) {
            failed.push(json!({ "member": m, "error": e }));
            continue;
        }
        todo.push((m.clone(), b));
    }
    // 2) 원래 폴더에서 고친 파일은 합칠 내용과 겹칠 때만 막는다 — 안 겹치면 git이 그대로 합치고 그 변경도 그대로 둔다
    //    (Unity가 다시 가져오며 고쳐 쓴 .meta 수백 개처럼 아무도 손대지 않은 부산물에 합치기가 계속 막히던 것)
    let df = dirty_files(repo);
    let mut stashed = String::new();
    if !df.is_empty() {
        let mut touch = std::collections::BTreeSet::new();
        for (_, b) in &todo {
            if let Ok(s) = git(repo, &["diff", "--name-only", &format!("{base}...{b}")]) {
                touch.extend(s.lines().map(|l| l.trim().trim_matches('"').replace('\\', "/")));
            }
        }
        let overlap: Vec<String> = df.iter().filter(|f| touch.contains(&f.replace('\\', "/"))).cloned().collect();
        if !overlap.is_empty() {
            if !stash {
                return Ok(json!({ "dirty": true, "dirty_files": overlap, "merged": [], "nothing": nothing, "conflicts": [], "failed": failed, "head": "" }));
            }
            stashed = format!("합치기 전 보관: 원래 폴더에서 고친 파일 {}개", df.len());
            git(repo, &["stash", "push", "-q", "-m", &stashed])?;
        }
    }
    // 합치기 전에 남아 있는 변경(겹치지 않는 것) — 실패해 되돌린 뒤에도 똑같아야 한다
    let keep = dirty_files(repo);
    for (m, b) in &todo {
        let (m, b) = (m.clone(), b.clone());
        // 공유: 넣을 게 있는지는 묶어 본 결과(빈 index)로 판단한다 — 미리 diff로 보면 되돌린 작업을 놓칠 수 있다
        if !shared && git(repo, &["rev-list", "--count", &format!("{base}..{b}")])?.trim().parse::<u32>().unwrap_or(0) == 0 {
            nothing.push(m.clone());
            continue;
        }
        let before = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
        let res = if shared {
            squash_one(repo, &b, message).map(|put| {
                if put {
                    // 묶어 넣은 커밋(검사가 파일을 고쳤을 수도 있다)에 에이전트 브랜치를 그대로 맞춘다 —
                    // 안 맞추면 다음 맞추기·합치기에서 같은 줄을 양쪽이 다르게 고친 것으로 보여 계속 충돌한다
                    let wt = wt_path(repo, team, &m);
                    let now = git(repo, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
                    if wt.exists() && !now.is_empty() {
                        let _ = git(&wt, &["reset", "-q", "--keep", &now]);
                    }
                }
                put
            })
        } else {
            git_id(repo, &["merge", "--no-ff", "--no-edit", "--no-verify", "-m", &format!("{message} ({m})"), &b]).map(|_| true)
        };
        if let Ok(false) = res {
            nothing.push(m.clone());
            continue;
        }
        if let Err(e) = res {
            let files = conflicted(repo);
            if git(repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
                let _ = git(repo, &["merge", "--abort"]);
            } else if shared {
                // 묶어 넣기(--squash)는 MERGE_HEAD가 없다 — 합치기 전으로 되돌린다(에이전트 브랜치엔 그대로 남아 있다).
                // --merge: 합치는 사이 사용자가 고친 파일이 있으면 지우지 않고 거부한다 → 아래 검사가 멈추고 알린다
                let _ = git(repo, &["reset", "-q", "--merge", &before]);
            }
            // 되돌렸는지 확인: 깨끗하고 HEAD가 그대로여야 다음으로 간다(아니면 멈추고 알린다)
            let now = git(repo, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
            if dirty_files(repo) != keep || now != before {
                return Err(format!("{m}을(를) 합치다 멈췄어요 — 원래 폴더를 확인해 주세요(합친 것: {}): {e}", if merged.is_empty() { "없음".to_string() } else { merged.join(", ") }));
            }
            if files.is_empty() {
                failed.push(json!({ "member": m, "error": e }));
            } else {
                conflicts.push(json!({ "member": m, "files": files }));
            }
            continue;
        }
        merged.push(m.clone());
    }
    let head = git(repo, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    Ok(json!({ "dirty": false, "merged": merged, "nothing": nothing, "conflicts": conflicts, "failed": failed, "head": head, "stashed": stashed }))
}

/// 원래 브랜치(합친 결과)를 이 에이전트 브랜치에 합쳐 맞춘다. 충돌이면 되돌리고 Err("CONFLICT: 파일들")
pub fn sync(repo: &Path, team: &str, member: &str) -> Result<(), String> {
    safe(team)?;
    safe(member)?;
    let dir = wt_path(repo, team, member);
    let _g = WT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !dir.exists() {
        return Ok(());
    }
    touch_active(&dir);
    let base = current_branch(repo)?;
    commit_wt(&dir, "팀: 맞추기 전 저장")?;
    if git_id(&dir, &["merge", "--no-edit", "--no-verify", &base]).is_err() {
        let files = conflicted(&dir);
        let _ = git(&dir, &["merge", "--abort"]);
        return Err(format!("CONFLICT: {}", files.join(", ")));
    }
    Ok(())
}

/// 합치기 확인에 보일 바뀐 내용 요약
pub fn diffstat(repo: &Path, team: &str, member: &str) -> Result<String, String> {
    safe(team)?;
    safe(member)?;
    let b = branch(team, member);
    if git(repo, &["rev-parse", "--verify", &b]).is_err() {
        return Ok(String::new());
    }
    commit_wt(&wt_path(repo, team, member), "팀: 확인 전 저장")?;
    let base = current_branch(repo)?;
    Ok(git(repo, &["diff", "--stat", &format!("{base}...{b}")])?.trim().to_string())
}

/// Claude 대화 파일을 다른 폴더의 프로젝트 기록으로 복사(이미 있으면 그대로). 복사했거나 있으면 true, 원본이 없으면 false
fn copy_session(from_dir: &Path, to_dir: &Path, id: &str) -> Result<bool, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("세션 id 형식 오류".into());
    }
    let to = to_dir.join(format!("{id}.jsonl"));
    if to.exists() {
        return Ok(true);
    }
    let from = from_dir.join(format!("{id}.jsonl"));
    if !from.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(to_dir).map_err(|e| e.to_string())?;
    std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------------- 명령 ----------------

#[tauri::command(async)]
pub fn team_kind(repo: String) -> String {
    kind(Path::new(&repo)).into()
}

#[tauri::command(async)]
pub fn team_repo(repo: String) -> Value {
    repo_state(Path::new(&repo))
}

#[tauri::command(async)]
pub fn team_init(repo: String) -> Result<(), String> {
    init(Path::new(&repo))
}

#[tauri::command(async)]
pub fn team_wt(repo: String, team: String, member: String) -> Result<String, String> {
    worktree(Path::new(&repo), &team, &member).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn team_merge(repo: String, team: String, members: Vec<String>, message: String, shared: Option<bool>, stash: Option<bool>) -> Result<Value, String> {
    merge(Path::new(&repo), &team, &members, &message, shared.unwrap_or(false), stash.unwrap_or(false))
}

#[tauri::command(async)]
pub fn team_branch_exists(repo: String, team: String, member: String) -> bool {
    safe(&team).is_ok() && safe(&member).is_ok() && branch_exists(Path::new(&repo), &team, &member)
}

#[tauri::command(async)]
pub fn team_sync(repo: String, team: String, member: String) -> Result<(), String> {
    sync(Path::new(&repo), &team, &member)
}

#[tauri::command(async)]
pub fn team_diffstat(repo: String, team: String, member: String) -> Result<String, String> {
    diffstat(Path::new(&repo), &team, &member)
}

#[tauri::command(async)]
pub fn claude_session_copy(from_cwd: String, to_cwd: String, id: String) -> Result<bool, String> {
    copy_session(&crate::util::claude_project_dir(&from_cwd), &crate::util::claude_project_dir(&to_cwd), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aith-twt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, rel: &str, text: &str) {
        let f = p.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, text).unwrap();
    }
    fn commit_all(p: &Path, msg: &str) {
        git(p, &["add", "-A"]).unwrap();
        git_id(p, &["commit", "-q", "-m", msg]).unwrap();
    }
    fn arr(v: &Value, k: &str) -> Vec<String> {
        v[k].as_array().unwrap().iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()
    }

    #[test]
    fn kind_detects_unity() {
        let d = tmp("kind");
        assert_eq!(kind(&d), "other");
        std::fs::create_dir_all(d.join("Assets")).unwrap();
        std::fs::create_dir_all(d.join("ProjectSettings")).unwrap();
        assert_eq!(kind(&d), "unity");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn init_writes_ignore_and_commits() {
        let d = tmp("init");
        std::fs::create_dir_all(d.join("Assets")).unwrap();
        std::fs::create_dir_all(d.join("ProjectSettings")).unwrap();
        write(&d, "Library/x.txt", "cache");
        write(&d, "a.cs", "class A {}");
        init(&d).unwrap();
        assert!(std::fs::read_to_string(d.join(".gitignore")).unwrap().contains("Library/"));
        assert!(git(&d, &["rev-parse", "--verify", "HEAD"]).is_ok());
        let files = git(&d, &["ls-files"]).unwrap();
        assert!(files.contains("a.cs"));
        assert!(!files.contains("Library/x.txt"));
        let _ = std::fs::remove_dir_all(&d);

        let e = tmp("init2");
        write(&e, ".gitignore", "mine\n");
        init(&e).unwrap();
        assert_eq!(std::fs::read_to_string(e.join(".gitignore")).unwrap(), "mine\n");
        let _ = std::fs::remove_dir_all(&e);
    }

    #[test]
    fn wt_merge_roundtrip_and_skips_unchanged() {
        let d = tmp("merge");
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        let w1 = worktree(&d, "t1", "m1").unwrap();
        let _w2 = worktree(&d, "t1", "m2").unwrap();
        assert_eq!(worktree(&d, "t1", "m1").unwrap(), w1);
        write(&w1, "b.txt", "from m1\n");
        let r = merge(&d, "t1", &["m1".into(), "m2".into()], "팀: 테스트", false, false).unwrap();
        assert_eq!(r["dirty"], false);
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        assert_eq!(arr(&r, "nothing"), vec!["m2"]);
        assert!(!r["head"].as_str().unwrap().is_empty());
        // 체크아웃 줄바꿈(core.autocrlf)은 무시
        assert_eq!(std::fs::read_to_string(d.join("b.txt")).unwrap().trim_end(), "from m1");
        // 합친 결과를 다른 에이전트 브랜치에 맞춘다
        sync(&d, "t1", "m2").unwrap();
        assert!(d.join(".aith/wt/t-t1-m2/b.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn merge_waits_when_dirty() {
        let d = tmp("dirty");
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "b.txt", "x\n");
        // .aith 안(워크트리)·도구가 만든 새 파일(테스트 결과물 등)만 있는 상태는 막지 않는다 — git 합치기에 걸리지 않는다
        write(&d, ".qa-playwright/report.html", "<html></html>");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert_eq!(r["dirty"], false);
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        assert!(d.join(".qa-playwright/report.html").exists());
        // 원래 폴더에서 고친 파일이 합칠 내용과 안 겹치면(Unity가 고쳐 쓴 .meta 같은 부산물) 막지 않고 합친다 — 그 변경은 그대로
        write(&w, "c.txt", "y\n");
        write(&d, "a.txt", "직접 고침\n");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert_eq!(r["dirty"], false, "{r}");
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim_end(), "직접 고침");
        // 겹치면 기다린다 — 겹치는 파일만 알려 준다
        write(&w, "a.txt", "에이전트\n");
        write(&d, "c.txt", "사용자\n");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert_eq!(r["dirty"], true);
        assert!(arr(&r, "merged").is_empty());
        assert_eq!(arr(&r, "dirty_files"), vec!["a.txt"]);
        // "보관하고 합치기": 고친 내용을 git stash에 보관(지우지 않음)하고 합친다
        let r = merge(&d, "t1", &["m1".into()], "팀", false, true).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"], "{r}");
        assert!(r["stashed"].as_str().unwrap().contains("보관"));
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim_end(), "에이전트");
        assert!(git(&d, &["stash", "list"]).unwrap().contains("합치기 전 보관"));
        assert!(git(&d, &["stash", "show", "-p"]).unwrap().contains("직접 고침"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn merge_conflict_aborts() {
        let d = tmp("conflict");
        write(&d, "a.txt", "원래\n");
        init(&d).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "a.txt", "에이전트\n");
        commit_all(&w, "m1");
        write(&d, "a.txt", "사용자\n");
        commit_all(&d, "user");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert!(arr(&r, "merged").is_empty());
        assert_eq!(r["conflicts"][0]["member"], "m1");
        assert_eq!(r["conflicts"][0]["files"][0], "a.txt");
        assert!(git(&d, &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim_end(), "사용자");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn snapshot_refuses_conflict_markers_and_unmerged() {
        let d = tmp("markers");
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "a.txt", "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert!(arr(&r, "merged").is_empty());
        assert_eq!(r["failed"][0]["member"], "m1");
        assert!(r["failed"][0]["error"].as_str().unwrap().contains("충돌 표시"));
        // 사용자 브랜치에는 아무것도 들어가지 않는다
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim_end(), "1");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn snapshot_ignores_user_hooks_and_signing() {
        let d = tmp("hooks");
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        // 실패하는 pre-commit 훅·서명 요구가 있어도 앱의 스냅샷·합치기 커밋은 된다
        write(&d, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
        git(&d, &["config", "commit.gpgsign", "true"]).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "b.txt", "x\n");
        let r = merge(&d, "t1", &["m1".into()], "팀", false, false).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn shared_repo(name: &str) -> PathBuf {
        let d = tmp(name);
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        git(&d, &["config", "user.name", "나"]).unwrap();
        git(&d, &["config", "user.email", "me@example.com"]).unwrap();
        d
    }

    #[test]
    fn shared_merge_squashes_under_user_name() {
        let d = shared_repo("shared");
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "b.txt", "1\n");
        commit_all(&w, "중간 저장 1");
        write(&w, "c.txt", "2\n");
        let before = git(&d, &["rev-list", "--count", "HEAD"]).unwrap().trim().to_string();
        let r = merge(&d, "t1", &["m1".into()], "feat: 로그인", true, false).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        // 에이전트 커밋 여러 개가 사용자 이름의 커밋 하나로
        let after = git(&d, &["rev-list", "--count", "HEAD"]).unwrap().trim().parse::<u32>().unwrap();
        assert_eq!(after, before.parse::<u32>().unwrap() + 1);
        assert_eq!(git(&d, &["log", "-1", "--format=%an|%s|%P"]).unwrap().trim().split('|').take(2).collect::<Vec<_>>(), vec!["나", "feat: 로그인"]);
        assert_eq!(git(&d, &["log", "-1", "--format=%P"]).unwrap().trim().split(' ').count(), 1);
        assert!(d.join("b.txt").exists() && d.join("c.txt").exists());
        // 맞춘 뒤 새 일이 없으면 넣을 게 없고, 새 일만 다음 커밋으로
        sync(&d, "t1", "m1").unwrap();
        let r = merge(&d, "t1", &["m1".into()], "feat: 로그인", true, false).unwrap();
        assert_eq!(arr(&r, "nothing"), vec!["m1"]);
        write(&w, "d.txt", "3\n");
        let r = merge(&d, "t1", &["m1".into()], "fix: 버튼", true, false).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"]);
        assert_eq!(git(&d, &["show", "--name-only", "--format=", "HEAD"]).unwrap().trim(), "d.txt");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn shared_merge_with_ff_false_and_reformatting_hook() {
        let d = shared_repo("shared-fmt");
        git(&d, &["config", "merge.ff", "false"]).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "f.txt", "foo( 1 )\n");
        // 커밋 때 파일을 고쳐 다시 올리는 검사(prettier·lint-staged 같은)
        write(&d, ".git/hooks/pre-commit", "#!/bin/sh\nsed -i 's/( 1 )/(1)/' f.txt\ngit add f.txt\n");
        let r = merge(&d, "t1", &["m1".into()], "feat: f", true, false).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"], "{r}");
        assert_eq!(std::fs::read_to_string(d.join("f.txt")).unwrap().trim_end(), "foo(1)");
        // 에이전트 브랜치가 고쳐진 결과에 맞춰져 맞추기·다음 합치기가 충돌하지 않는다
        sync(&d, "t1", "m1").unwrap();
        assert_eq!(std::fs::read_to_string(w.join("f.txt")).unwrap().trim_end(), "foo(1)");
        write(&w, "g.txt", "2\n");
        let r = merge(&d, "t1", &["m1".into()], "feat: g", true, false).unwrap();
        assert_eq!(arr(&r, "merged"), vec!["m1"], "{r}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn shared_merge_keeps_repo_hooks_and_rolls_back() {
        let d = shared_repo("shared-hook");
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "b.txt", "x\n");
        // 그 저장소의 검사(pre-commit)를 지킨다 — 실패하면 넣지 않고 그대로 되돌린다
        write(&d, ".git/hooks/pre-commit", "#!/bin/sh\necho 린트 실패 >&2\nexit 1\n");
        let head = git(&d, &["rev-parse", "HEAD"]).unwrap();
        let r = merge(&d, "t1", &["m1".into()], "feat: x", true, false).unwrap();
        assert!(arr(&r, "merged").is_empty());
        assert!(r["failed"][0]["error"].as_str().unwrap().contains("린트 실패"));
        assert_eq!(git(&d, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(git(&d, &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert!(!d.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn shared_merge_conflict_rolls_back() {
        let d = shared_repo("shared-conflict");
        let w = worktree(&d, "t1", "m1").unwrap();
        write(&w, "a.txt", "에이전트\n");
        commit_all(&w, "m1");
        write(&d, "a.txt", "사용자\n");
        commit_all(&d, "user");
        let r = merge(&d, "t1", &["m1".into()], "feat: x", true, false).unwrap();
        assert_eq!(r["conflicts"][0]["files"][0], "a.txt");
        assert!(git(&d, &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim_end(), "사용자");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn repo_state_reports_subfolder_prefix() {
        let d = tmp("prefix");
        write(&d, "pkg/app/a.txt", "1\n");
        init(&d).unwrap();
        assert_eq!(repo_state(&d)["prefix"], "");
        assert_eq!(repo_state(&d.join("pkg/app"))["prefix"], "pkg/app/");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn session_copy() {
        let d = tmp("sess");
        let (from, to) = (d.join("from"), d.join("to"));
        write(&from, "s1.jsonl", "{\"a\":1}\n");
        assert!(copy_session(&from, &to, "s1").unwrap());
        assert_eq!(std::fs::read_to_string(to.join("s1.jsonl")).unwrap(), "{\"a\":1}\n");
        write(&to, "s1.jsonl", "keep\n");
        assert!(copy_session(&from, &to, "s1").unwrap());
        assert_eq!(std::fs::read_to_string(to.join("s1.jsonl")).unwrap(), "keep\n");
        assert!(!copy_session(&from, &to, "none").unwrap());
        assert!(copy_session(&from, &to, "../x").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn branch_survives_removed_worktree() {
        let d = tmp("wtgone");
        write(&d, "a.txt", "1\n");
        init(&d).unwrap();
        let w = worktree(&d, "t1", "m1").unwrap();
        std::fs::remove_dir_all(&w).unwrap();
        let _ = git(&d, &["worktree", "prune"]);
        assert!(branch_exists(&d, "t1", "m1"));
        assert!(!branch_exists(&d, "t1", "m2"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
