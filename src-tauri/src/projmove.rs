// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 프로젝트 경로 바꾸기: 사용자가 프로젝트 폴더를 옮긴 뒤 탭이 새 경로를 쓰게 할 때,
//! 에이전트 기억(Claude 대화 기록 ~/.claude/projects/<인코딩된 경로> — 대화 파일·곁 폴더·memory/)을 새 경로 쪽으로 복사하고
//! 팀 에이전트 작업 폴더(git worktree)의 연결을 고친다. 원래 기록은 지우지 않는다(덮어쓰지도 않는다).

use std::path::Path;

use serde_json::{json, Value};

use crate::util::claude_project_dir;

/// a의 내용을 b로 복사한다. b에 이미 있는 파일은 그대로 둔다. 복사한 파일 수
fn merge_copy(a: &Path, b: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(b)?;
    let mut n = 0;
    for e in std::fs::read_dir(a)? {
        let e = e?;
        let ft = e.file_type()?;
        let to = b.join(e.file_name());
        if ft.is_dir() {
            n += merge_copy(&e.path(), &to)?;
        } else if ft.is_file() && !to.exists() {
            std::fs::copy(e.path(), &to)?;
            n += 1;
        }
    }
    Ok(n)
}

/// 한 경로의 Claude 기록을 다른 경로 쪽으로(원래 기록이 없으면 0)
fn copy_memory(from: &str, to: &str) -> Result<usize, String> {
    let (a, b) = (claude_project_dir(from), claude_project_dir(to));
    if a == b || !a.is_dir() {
        return Ok(0);
    }
    merge_copy(&a, &b).map_err(|e| format!("대화 기록을 옮기지 못했어요({}): {e}", a.display()))
}

/// from → to(새 프로젝트 폴더). worktrees: 팀 에이전트 작업 폴더 (옛 경로, 새 경로).
/// 새 작업 폴더가 없으면(폴더를 통째로 옮기지 않고 새로 받은 경우 등) 그 에이전트 기록은 새 프로젝트 폴더 쪽으로 옮기고 missing에 알린다
pub fn move_project(from: &str, to: &str, worktrees: &[(String, String)]) -> Result<Value, String> {
    if !Path::new(to).is_dir() {
        return Err(format!("새 폴더가 없어요: {to}"));
    }
    let mut copied = copy_memory(from, to)?;
    let (mut ok, mut missing) = (vec![], vec![]);
    for (old, new) in worktrees {
        if Path::new(new).is_dir() {
            copied += copy_memory(old, new)?;
            ok.push(new.clone());
        } else {
            copied += copy_memory(old, to)?;
            missing.push(new.clone());
        }
    }
    // 옮긴 작업 폴더와 저장소를 서로 다시 잇는다(git이 양쪽에 절대 경로를 적어 둔다)
    let repaired = if ok.is_empty() {
        true
    } else {
        let mut args = vec!["worktree", "repair"];
        args.extend(ok.iter().map(String::as_str));
        crate::github::git(to, &args).is_ok()
    };
    Ok(json!({ "copied": copied, "missing": missing, "repaired": repaired }))
}

#[tauri::command(async)]
pub fn project_move(from: String, to: String, worktrees: Vec<(String, String)>) -> Result<Value, String> {
    move_project(&from, &to, &worktrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_without_overwriting() {
        let base = std::env::temp_dir().join(format!("aith-pm-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(a.join("s1/subagents")).unwrap();
        std::fs::create_dir_all(a.join("memory")).unwrap();
        std::fs::write(a.join("s1.jsonl"), "old").unwrap();
        std::fs::write(a.join("s1/subagents/x.jsonl"), "sub").unwrap();
        std::fs::write(a.join("memory/MEMORY.md"), "기억").unwrap();
        std::fs::create_dir_all(b.join("memory")).unwrap();
        std::fs::write(b.join("memory/MEMORY.md"), "새 쪽 기억").unwrap();
        assert_eq!(merge_copy(&a, &b).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(b.join("s1.jsonl")).unwrap(), "old");
        assert!(b.join("s1/subagents/x.jsonl").exists());
        // 이미 있는 파일은 덮어쓰지 않는다
        assert_eq!(std::fs::read_to_string(b.join("memory/MEMORY.md")).unwrap(), "새 쪽 기억");
        // 원래 기록은 그대로
        assert!(a.join("s1.jsonl").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktrees_work_after_the_folder_moves() {
        let base = std::env::temp_dir().join(format!("aith-pmwt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (old, new) = (base.join("old"), base.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        let g = |dir: &Path, args: &[&str]| crate::github::git(&dir.to_string_lossy(), args).unwrap();
        g(&old, &["init", "-q"]);
        std::fs::write(old.join("a.txt"), "1").unwrap();
        g(&old, &["add", "-A"]);
        g(&old, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
        g(&old, &["worktree", "add", "-q", "-b", "aith/x", ".aith/wt/t-x-m1"]);
        // 사용자가 폴더를 통째로 옮김
        std::fs::rename(&old, &new).unwrap();
        let wt = new.join(".aith/wt/t-x-m1");
        assert!(crate::github::git(&wt.to_string_lossy(), &["status"]).is_err(), "옮기면 작업 폴더 연결이 끊긴다");
        let (o, n) = (old.join(".aith/wt/t-x-m1").to_string_lossy().into_owned(), wt.to_string_lossy().into_owned());
        let r = move_project(&old.to_string_lossy(), &new.to_string_lossy(), &[(o, n)]).unwrap();
        assert_eq!(r["repaired"], true);
        assert!(r["missing"].as_array().unwrap().is_empty());
        assert!(crate::github::git(&wt.to_string_lossy(), &["status"]).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_missing_target() {
        assert!(move_project("C:/x", "C:/definitely/not/here/aith", &[]).is_err());
    }
}
