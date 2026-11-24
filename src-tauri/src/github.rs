// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! GitHub 연동(gh CLI): PR·이슈 목록/내용, diff, 리뷰(승인·변경 요청·코멘트), 병합, PR 만들기.
//! 임의 명령을 받지 않고 정해진 gh 하위 명령만 실행한다. 쉘을 거치지 않아 본문에 특수문자가 있어도 안전.

use std::path::Path;
use std::process::Command;


const NO_WINDOW: u32 = 0x0800_0000;

fn run(program: &str, cwd: &str, args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    if !Path::new(cwd).is_dir() {
        return Err("프로젝트 폴더가 없어요".into());
    }
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { format!("{program}가 설치돼 있지 않아요") } else { e.to_string() })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{program} {} 실패", args.first().unwrap_or(&"")) } else { err })
    }
}

pub(crate) fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    run("gh", cwd, args)
}

pub(crate) fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    run("git", cwd, args).map(|s| s.trim().to_string())
}

/// 지금 브랜치를 올리고(push -u origin HEAD) PR을 만든다. PR 주소 반환
#[tauri::command(async)]
pub fn gh_pr_create(cwd: String, title: String, body: String, base: String, draft: bool) -> Result<String, String> {
    if !crate::util::safe_arg(&base) {
        return Err("잘못된 브랜치 이름".into());
    }
    if title.trim().is_empty() {
        return Err("제목을 써 주세요".into());
    }
    let branch = git(&cwd, &["branch", "--show-current"])?;
    if branch.is_empty() || branch == base {
        return Err(format!("지금 브랜치({})에서는 {base}로 PR을 만들 수 없어요. 작업 브랜치에서 만들어 주세요", if branch.is_empty() { "분리된 HEAD" } else { &branch }));
    }
    run("git", &cwd, &["push", "-u", "origin", "HEAD"])?;
    let mut args = vec!["pr", "create", "--base", base.as_str(), "--head", branch.as_str(), "--title", title.as_str(), "--body", body.as_str()];
    if draft {
        args.push("--draft");
    }
    gh(&cwd, &args).map(|s| s.lines().last().unwrap_or("").trim().to_string())
}

// ---------------- 원격 팀원(AI 회사 본사·지사) ----------------


/// 이 PC의 gh 로그인 아이디
#[tauri::command(async)]
pub fn gh_login(cwd: String) -> Result<String, String> {
    let s = gh(&cwd, &["api", "user", "--jq", ".login"])?.trim().to_string();
    if s.is_empty() { Err("gh 로그인 정보를 못 읽었어요".into()) } else { Ok(s) }
}

/// 홈 폴더(gh를 특정 저장소 밖에서 부를 때)
fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
}

/// 이 계정의 noreply 커밋 이메일(`{id}+{login}@users.noreply.github.com`) — 이 주소로 커밋해야 잔디에 잡힌다
#[tauri::command(async)]
pub fn gh_noreply() -> Result<String, String> {
    // jq 문자열 보간은 따옴표 안에서만 된다
    let s = gh(&home(), &["api", "user", "--jq", "\"\\(.id)+\\(.login)@users.noreply.github.com\""])?.trim().to_string();
    if s.contains('@') && !s.starts_with('+') { Ok(s) } else { Err("gh 로그인 정보를 못 읽었어요(gh auth login)".into()) }
}

/// 저장소 이름으로 쓸 수 있는지(GitHub 규칙: 영숫자·`.`·`_`·`-`)
fn repo_name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name != "." && name != ".." && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// 이미 있는 git 저장소로 내 계정에 새 GitHub 저장소를 만들고 origin으로 올린다(커밋된 것만). 저장소 주소 반환
#[tauri::command(async)]
pub fn gh_repo_create(cwd: String, name: String, private: bool) -> Result<String, String> {
    if !repo_name_ok(&name) {
        return Err("저장소 이름은 영문·숫자·. _ - 만 쓸 수 있어요".into());
    }
    let vis = if private { "--private" } else { "--public" };
    let out = gh(&cwd, &["repo", "create", &name, vis, "--source", ".", "--remote", "origin", "--push"])?;
    match out.lines().map(str::trim).filter(|l| l.starts_with("https://")).last() {
        Some(u) => Ok(u.to_string()),
        None => gh(&cwd, &["repo", "view", "--json", "url", "--jq", ".url"]).map(|s| s.trim().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_names_are_checked_before_running_gh() {
        let d = std::env::temp_dir().to_string_lossy().to_string();
        assert!(repo_name_ok("DiceGame") && repo_name_ok("my-game_2.0"));
        assert!(!repo_name_ok("a b") && !repo_name_ok("..") && !repo_name_ok("x/y") && !repo_name_ok(""));
        assert!(gh_repo_create(d, "a b".into(), true).is_err());

    }
}
