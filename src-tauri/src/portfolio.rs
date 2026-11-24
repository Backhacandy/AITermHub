// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 포트폴리오: 잔디 폴더마다 프로젝트 정보(기간·커밋 수·기술·README 앞부분)를 모으고,
//! GitHub 프로필 저장소(`login/login`)의 README를 gh api로 읽고 쓴다(앱이 쓰는 부분은 프론트가 표시 사이만 바꾼다).

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};

const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Debug, PartialEq)]
pub struct ProjectInfo {
    pub dir: String,
    pub name: String,
    /// 첫·마지막 커밋 날짜(YYYY-MM-DD, git이 아니면 빈 글)
    pub first: String,
    pub last: String,
    pub commits: u32,
    pub tech: Vec<String>,
    /// README 앞부분(한 줄 설명 초안용, 최대 1500자)
    pub readme: String,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(dir).creation_flags(NO_WINDOW).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 쓰인 기술(폴더 안 표시 파일로)
pub fn detect_tech(dir: &Path) -> Vec<String> {
    let has = |p: &str| dir.join(p).exists();
    let mut t: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        if !t.iter().any(|x| x == s) {
            t.push(s.to_string());
        }
    };
    if has("Assets") && has("ProjectSettings") {
        add("Unity");
        add("C#");
    }
    let names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
        .unwrap_or_default();
    if names.iter().any(|n| n.ends_with(".uproject")) {
        add("Unreal");
        add("C++");
    }
    if has("src-tauri") {
        add("Tauri");
    }
    if has("Cargo.toml") || has("src-tauri/Cargo.toml") {
        add("Rust");
    }
    if let Ok(pkg) = std::fs::read_to_string(dir.join("package.json")) {
        let p = pkg.to_lowercase();
        for (k, v) in [("\"svelte\"", "Svelte"), ("\"react\"", "React"), ("\"vue\"", "Vue"), ("\"next\"", "Next.js"), ("\"electron\"", "Electron")] {
            if p.contains(k) {
                add(v);
            }
        }
        add(if p.contains("\"typescript\"") || has("tsconfig.json") { "TypeScript" } else { "JavaScript" });
    }
    if has("pyproject.toml") || has("requirements.txt") || names.iter().any(|n| n.ends_with(".py")) {
        add("Python");
    }
    if has("build.gradle") || has("build.gradle.kts") || has("app/build.gradle") || has("app/build.gradle.kts") {
        add("Android");
        add("Kotlin");
    }
    if names.iter().any(|n| n.ends_with(".sln") || n.ends_with(".csproj")) {
        add("C#");
    }
    if has("go.mod") {
        add("Go");
    }
    t
}

fn readme_head(dir: &Path) -> String {
    for n in ["README.md", "readme.md", "Readme.md", "README.txt", "README"] {
        if let Ok(s) = std::fs::read_to_string(dir.join(n)) {
            return s.chars().take(1500).collect();
        }
    }
    String::new()
}

pub fn scan_one(dir: &str) -> ProjectInfo {
    let p = Path::new(dir);
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string());
    let is_git = git(p, &["rev-parse", "--verify", "HEAD"]).is_some();
    let (first, last, commits) = if is_git {
        let first = git(p, &["log", "--reverse", "--format=%cs"]).and_then(|s| s.lines().next().map(str::to_string)).unwrap_or_default();
        let last = git(p, &["log", "-1", "--format=%cs"]).unwrap_or_default();
        let commits = git(p, &["rev-list", "--count", "HEAD"]).and_then(|s| s.parse().ok()).unwrap_or(0);
        (first, last, commits)
    } else {
        (String::new(), String::new(), 0)
    };
    ProjectInfo { dir: dir.to_string(), name, first, last, commits, tech: detect_tech(p), readme: readme_head(p) }
}

#[tauri::command(async)]
pub fn portfolio_scan(dirs: Vec<String>) -> Vec<ProjectInfo> {
    dirs.iter().filter(|d| Path::new(d.as_str()).is_dir()).map(|d| scan_one(d)).collect()
}

fn gh(args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write;
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .current_dir(home)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .creation_flags(NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    let mut child = cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "gh가 설치돼 있지 않아요".to_string() } else { e.to_string() })?;
    if let Some(text) = input {
        child.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn login() -> Result<String, String> {
    let s = gh(&["api", "user", "--jq", ".login"], None)?.trim().to_string();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Err("gh 로그인 정보를 못 읽었어요(gh auth login)".into())
    } else {
        Ok(s)
    }
}

/// 프로필 README: {login, exists(저장소), sha, content}. 저장소가 없으면 exists=false
#[tauri::command(async)]
pub fn gh_profile_get() -> Result<Value, String> {
    use base64::Engine;
    let login = login()?;
    if gh(&["api", &format!("repos/{login}/{login}"), "--jq", ".name"], None).is_err() {
        return Ok(json!({ "login": login, "exists": false, "sha": "", "content": "" }));
    }
    match gh(&["api", &format!("repos/{login}/{login}/contents/README.md")], None) {
        Ok(raw) => {
            let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let b64: String = v["content"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
            Ok(json!({ "login": login, "exists": true, "sha": v["sha"].as_str().unwrap_or(""), "content": String::from_utf8_lossy(&bytes) }))
        }
        // 저장소는 있는데 README가 없음
        Err(_) => Ok(json!({ "login": login, "exists": true, "sha": "", "content": "" })),
    }
}

/// 프로필 README 쓰기(sha가 있으면 덮어쓰기). 프로필 주소 반환
#[tauri::command(async)]
pub fn gh_profile_put(content: String, sha: String) -> Result<String, String> {
    use base64::Engine;
    let login = login()?;
    let mut body = json!({
        "message": "포트폴리오: 프로젝트 목록 갱신",
        "content": base64::engine::general_purpose::STANDARD.encode(content.as_bytes()),
    });
    if !sha.is_empty() {
        body["sha"] = json!(sha);
    }
    gh(&["api", "-X", "PUT", &format!("repos/{login}/{login}/contents/README.md"), "--input", "-"], Some(&body.to_string()))?;
    Ok(format!("https://github.com/{login}"))
}

/// 프로필 저장소(`login/login`, 공개) 만들기 — 사용자가 버튼으로
#[tauri::command(async)]
pub fn gh_profile_create() -> Result<String, String> {
    let login = login()?;
    gh(&["repo", "create", &login, "--public", "--description", "프로필"], None)?;
    Ok(format!("https://github.com/{login}/{login}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aith-pf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_tech() {
        let u = tmp("unity");
        std::fs::create_dir_all(u.join("Assets")).unwrap();
        std::fs::create_dir_all(u.join("ProjectSettings")).unwrap();
        assert_eq!(detect_tech(&u), vec!["Unity", "C#"]);
        let w = tmp("web");
        std::fs::write(w.join("package.json"), r#"{"devDependencies":{"svelte":"5","typescript":"6"}}"#).unwrap();
        std::fs::create_dir_all(w.join("src-tauri")).unwrap();
        std::fs::write(w.join("src-tauri/Cargo.toml"), "").unwrap();
        assert_eq!(detect_tech(&w), vec!["Tauri", "Rust", "Svelte", "TypeScript"]);
        let p = tmp("py");
        std::fs::write(p.join("main.py"), "print(1)").unwrap();
        assert_eq!(detect_tech(&p), vec!["Python"]);
        for d in [u, w, p] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn scans_period_and_commits() {
        let d = tmp("scan");
        std::fs::write(d.join("README.md"), "# 게임\n숫자 맞히기 게임").unwrap();
        let run = |a: &[&str]| assert!(Command::new("git").args(a).current_dir(&d).creation_flags(NO_WINDOW).output().unwrap().status.success());
        run(&["init", "-q"]);
        run(&["add", "-A"]);
        run(&["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "1"]);
        run(&["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "2"]);
        let i = scan_one(d.to_str().unwrap());
        assert_eq!(i.commits, 2);
        assert_eq!(i.first.len(), 10);
        assert_eq!(i.first, i.last);
        assert!(i.readme.contains("숫자 맞히기"));
        let none = scan_one(tmp("nogit").to_str().unwrap());
        assert_eq!((none.commits, none.first.as_str()), (0, ""));
        let _ = std::fs::remove_dir_all(&d);
    }
}
