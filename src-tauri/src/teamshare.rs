// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 남의 저장소(공유 저장소)에서 팀 작업: 원격·권한 알아보기, 작업 브랜치 만들기, push하고 PR 올리기.
//! 공유 저장소에서 합치기는 사용자 이름으로·그 저장소의 검사(hook)·서명 설정을 지키며 하나로 묶어 한다(teamwt::merge).
//! push·PR은 사용자가 카드에서 누를 때만 한다.

use serde_json::{json, Value};

use crate::github::{gh, git};

/// GitHub 원격 주소에서 소유자·저장소 이름. https·ssh와 SSH 호스트 별칭(git@github.com-work:o/r)도 받는다.
/// 주소에 붙은 로그인 정보는 뗀다
pub fn parse_github(url: &str) -> Option<(String, String)> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = if let Some(r) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).or_else(|| u.strip_prefix("ssh://")) {
        // [사용자[:토큰]@]호스트[:포트]/o/r
        let r = r.rsplit_once('@').map(|(_, h)| h).unwrap_or(r);
        let (host, path) = r.split_once('/')?;
        if !host.split(':').next()?.starts_with("github.com") {
            return None;
        }
        path.to_string()
    } else {
        // git@호스트:o/r (호스트는 github.com 또는 github.com-xxx 같은 별칭)
        let (left, path) = u.split_once(':')?;
        let host = left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left);
        if !host.starts_with("github.com") {
            return None;
        }
        path.to_string()
    };
    let mut it = rest.split('/');
    let (o, r) = (it.next()?, it.next()?);
    if o.is_empty() || r.is_empty() || it.next().is_some() {
        return None;
    }
    Some((o.to_string(), r.to_string()))
}

/// 남의 저장소인지: 소유자가 내 gh 아이디가 아니면. 아이디를 모르면 공유로 본다(조심하는 쪽)
fn is_shared(owner: &str, login: &str) -> bool {
    login.is_empty() || !owner.eq_ignore_ascii_case(login)
}

/// 원격이 기억하는 기본 브랜치(refs/remotes/origin/HEAD)
fn origin_head(cwd: &str) -> String {
    git(cwd, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).map(|s| s.trim().trim_start_matches("refs/remotes/origin/").to_string()).unwrap_or_default()
}

/// GitHub 저장소 정보: (push 권한, 기본 브랜치, fork면 원본 "o/r")
fn repo_info(cwd: &str, full: &str) -> Option<(bool, String, String)> {
    let s = gh(cwd, &["api", &format!("repos/{full}"), "--jq", "[.permissions.push, .default_branch, (.parent.full_name // \"\")] | @tsv"]).ok()?;
    let mut p = s.trim_end_matches(['\r', '\n']).split('\t');
    let push = p.next()? != "false";
    Some((push, p.next().unwrap_or("").trim().to_string(), p.next().unwrap_or("").trim().to_string()))
}

/// 이 폴더의 원격 정보. 원격이 없으면 shared: false(혼자 쓰는 저장소).
/// - origin이 내 fork면 원본 저장소가 PR 대상(공유)이고 push는 origin(내 fork)으로
/// - 다른 원격(upstream 등)에 남의 저장소가 있으면 공유로 본다
/// - GitHub에 물어보지 못하면 공유로 보고, 기본 브랜치는 origin/HEAD에서
pub fn remote(cwd: &str) -> Value {
    let url = match git(cwd, &["remote", "get-url", "origin"]) {
        Ok(u) if !u.is_empty() => u,
        _ => return json!({ "shared": false, "remote": false, "github": false, "push": true, "default": "" }),
    };
    let Some((oo, on)) = parse_github(&url) else {
        return json!({ "shared": true, "remote": true, "github": false, "push": true, "default": origin_head(cwd) });
    };
    let login = gh(cwd, &["api", "user", "--jq", ".login"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let others = git(cwd, &["remote", "-v"]).unwrap_or_default();
    let other_owner_differs = others.lines().filter_map(|l| l.split_whitespace().nth(1)).filter_map(parse_github).any(|(o, _)| is_shared(&o, &login));
    let origin_full = format!("{oo}/{on}");
    let info = repo_info(cwd, &origin_full);
    let (push, mut default, parent) = info.clone().unwrap_or((true, String::new(), String::new()));
    // origin이 내 fork: PR은 원본으로, push는 origin으로
    let (owner, name, push, fork_origin) = if !parent.is_empty() && !is_shared(&oo, &login) {
        let (po, pn) = parent.split_once('/').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((oo.clone(), on.clone()));
        if let Some((_, d, _)) = repo_info(cwd, &parent) {
            default = d;
        }
        (po, pn, true, true)
    } else {
        (oo.clone(), on.clone(), push, false)
    };
    if default.is_empty() {
        default = origin_head(cwd);
    }
    let shared = info.is_none() || fork_origin || is_shared(&owner, &login) || other_owner_differs;
    json!({
        "shared": shared, "remote": true, "github": true, "owner": owner, "name": name, "login": login,
        "push": push, "default": default, "forkOrigin": fork_origin, "originOwner": oo,
    })
}

/// 작업 브랜치를 새로 만들어 옮긴다(커밋 안 한 변경은 그대로 따라온다)
pub fn new_branch(cwd: &str, name: &str) -> Result<(), String> {
    if !crate::util::safe_arg(name) || name.starts_with('-') || git(cwd, &["check-ref-format", "--branch", name]).is_err() {
        return Err(format!("브랜치 이름이 올바르지 않아요: {name}"));
    }
    git(cwd, &["switch", "-c", name]).map(|_| ())
}

/// gh 출력에서 마지막 주소
fn last_url(s: &str) -> String {
    s.split_whitespace().filter(|w| w.starts_with("https://")).last().unwrap_or("").to_string()
}

/// 올리면 안 되는 브랜치: 기본 브랜치, 기본 브랜치를 모르면 main·master
fn protected(branch: &str, default: &str) -> bool {
    if default.is_empty() {
        branch == "main" || branch == "master"
    } else {
        branch == default
    }
}

/// 지금 브랜치를 올리고(pr이면 PR도 만든다). expect: 카드에 보여 준 브랜치 — 지금 브랜치가 다르면 올리지 않는다.
/// 쓰기 권한이 없으면 내 계정에 fork를 만들어 거기에 올린다. 이미 열린 PR이 있으면 push만으로 그 PR에 반영되니 그 주소
pub fn push_pr(cwd: &str, expect: &str, title: &str, body: &str, pr: bool) -> Result<Value, String> {
    let r = remote(cwd);
    if r["remote"] != true {
        return Err("원격 저장소(origin)가 없어요".into());
    }
    let branch = git(cwd, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("브랜치가 아닌 상태(detached HEAD)라 올릴 수 없어요".into());
    }
    if branch != expect {
        return Err(format!("지금 브랜치가 {branch}로 바뀌어 올리지 않았어요(카드는 {expect}) — 다시 합치면 새 카드가 떠요"));
    }
    let s = |k: &str| r[k].as_str().unwrap_or("").to_string();
    let (owner, name, login, default) = (s("owner"), s("name"), s("login"), s("default"));
    if protected(&branch, &default) {
        return Err(format!("{branch}는 기본 브랜치라 올리지 않았어요 — 작업 브랜치에서 올려 주세요"));
    }
    let github = r["github"] == true;
    let need_fork = github && r["push"] == false;
    let (to, head) = if need_fork {
        if login.is_empty() {
            return Err("쓰기 권한이 없어 내 계정에 fork를 만들어야 하는데 gh 로그인이 안 돼 있어요(gh auth login)".into());
        }
        // 실제로 만들어진 fork 이름을 받는다(같은 이름 저장소가 있으면 name-1 등으로 만들어진다)
        let full = gh(cwd, &["api", "-X", "POST", &format!("repos/{owner}/{name}/forks"), "--jq", ".full_name"]).map_err(|e| format!("fork를 만들지 못했어요: {e}"))?.trim().to_string();
        let Some((fo, fname)) = full.split_once('/') else {
            return Err(format!("fork 이름을 알 수 없어요: {full}"));
        };
        match git(cwd, &["remote", "get-url", "fork"]) {
            Ok(u) => {
                if parse_github(&u).map(|(a, b)| a.eq_ignore_ascii_case(fo) && b.eq_ignore_ascii_case(fname)) != Some(true) {
                    return Err(format!("이미 있는 'fork' 원격({u})이 {full}이 아니라 올리지 않았어요"));
                }
            }
            Err(_) => {
                git(cwd, &["remote", "add", "fork", &format!("https://github.com/{full}.git")])?;
            }
        }
        ("fork".to_string(), format!("{fo}:{branch}"))
    } else if r["forkOrigin"] == true {
        ("origin".to_string(), format!("{}:{branch}", s("originOwner")))
    } else {
        ("origin".to_string(), branch.clone())
    };
    git(cwd, &["push", "-u", &to, "HEAD"])?;
    let done = |url: String, existing: bool| json!({ "pushed": true, "branch": branch, "fork": need_fork, "url": url, "existing": existing });
    if !pr || !github {
        return Ok(done(String::new(), false));
    }
    let title = title.lines().next().unwrap_or("").trim();
    if title.is_empty() {
        return Err("올렸지만 PR 제목이 비어 PR은 만들지 않았어요".into());
    }
    let repo = format!("{owner}/{name}");
    let mut args = vec!["pr", "create", "--repo", repo.as_str(), "--head", head.as_str(), "--title", title, "--body", body];
    if !default.is_empty() {
        args.extend(["--base", default.as_str()]);
    }
    match gh(cwd, &args) {
        Ok(out) => Ok(done(last_url(&out), false)),
        Err(e) if e.contains("already exists") => Ok(done(last_url(&e), true)),
        Err(e) => Err(format!("올렸지만 PR을 만들지 못했어요: {e}")),
    }
}

#[tauri::command(async)]
pub fn team_remote(repo: String) -> Value {
    remote(&repo)
}

#[tauri::command(async)]
pub fn team_new_branch(repo: String, name: String) -> Result<(), String> {
    new_branch(&repo, &name)
}

#[tauri::command(async)]
pub fn team_push_pr(repo: String, branch: String, title: String, body: String, pr: bool) -> Result<Value, String> {
    push_pr(&repo, &branch, &title, &body, pr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls() {
        let want = Some(("example-user".to_string(), "example-web".to_string()));
        assert_eq!(parse_github("https://github.com/example-user/example-web.git"), want);
        assert_eq!(parse_github("https://github.com/example-user/example-web"), want);
        assert_eq!(parse_github("git@github.com:example-user/example-web.git"), want);
        assert_eq!(parse_github("ssh://git@github.com/example-user/example-web.git"), want);
        assert_eq!(parse_github("https://me:tok@github.com/example-user/example-web.git\n"), want);
        // 회사·개인 계정을 나눠 쓰는 SSH 호스트 별칭
        assert_eq!(parse_github("git@github.com-work:example-user/example-web.git"), want);
        assert_eq!(parse_github("https://gitlab.com/a/b.git"), None);
        assert_eq!(parse_github("git@gitlab.com:a/b.git"), None);
        assert_eq!(parse_github("https://github.com/a"), None);
    }

    #[test]
    fn shared_when_not_mine_or_unknown() {
        assert!(!is_shared("Backhacandy", "backhacandy"));
        assert!(is_shared("example-user", "Backhacandy"));
        assert!(is_shared("Backhacandy", ""));
    }

    #[test]
    fn default_branch_is_never_pushed() {
        assert!(protected("master", "master"));
        assert!(!protected("feature/frontend", "master"));
        // 기본 브랜치를 모르면 main·master를 막는다
        assert!(protected("main", "") && protected("master", ""));
        assert!(!protected("feature/x", ""));
    }

    #[test]
    fn bad_branch_names_are_refused() {
        let d = std::env::temp_dir().to_string_lossy().to_string();
        for n in ["", "-x", "a b", "a..b", "x;rm"] {
            assert!(new_branch(&d, n).is_err(), "{n}");
        }
    }
}
