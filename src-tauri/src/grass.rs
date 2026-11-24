// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! GitHub 잔디 자동 올리기: 정해 둔 폴더(이미 GitHub 저장소와 연결된 git 저장소)의 바뀐 것을 커밋해 올린다.
//! 50MB 넘는 파일·비밀로 보이는 파일(이름·내용)은 올리지 않고 .git/info/exclude에 적어 다음에도 빼며,
//! 작성자 이메일은 계정의 noreply 주소로(설정에 저장, gh 계정에서 만든다) — 그래야 잔디에 잡힌다.

use std::path::Path;
use std::process::Command;

const BIG: u64 = 50 * 1024 * 1024;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct GrassResult {
    /// "committed" | "clean" | "error"
    pub status: String,
    pub message: String,
    /// 이번에 뺀 파일(크기·비밀)
    pub skipped: Vec<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.output().map_err(|e| e.to_string())
}

fn ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = git(dir, args)?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect());
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// 이름만 보고 비밀로 보이는 파일
pub fn secret_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n == ".env"
        || n.starts_with(".env.")
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|e| n.ends_with(e))
        || (n.starts_with("credentials") && n.ends_with(".json"))
        || n.starts_with("service-account") && n.ends_with(".json")
        || n.starts_with("serviceaccount") && n.ends_with(".json")
        || n == "secrets.json"
        || n == "secret.json"
        || n.starts_with("id_rsa")
        || n == ".npmrc"
        || n == "auth.json"
}

/// 내용에 API 키·개인 키가 보이는지(텍스트 파일만)
pub fn secret_text(text: &str) -> bool {
    let has_prefixed = |pre: &str, min: usize| {
        text.match_indices(pre).any(|(i, _)| {
            text[i + pre.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count() >= min
        })
    };
    has_prefixed("sk-ant-", 20)
        || has_prefixed("ghp_", 36)
        || has_prefixed("github_pat_", 30)
        || has_prefixed("AIza", 35)
        || has_prefixed("xoxb-", 10)
        || has_prefixed("xoxp-", 10)
        || text.contains("PRIVATE KEY-----")
        || text.match_indices("AKIA").any(|(i, _)| text[i + 4..].chars().take(16).filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).count() == 16)
}

const TEXT_EXT: &[&str] = &[
    "txt", "md", "json", "js", "ts", "tsx", "jsx", "py", "cs", "java", "kt", "swift", "yml", "yaml", "toml", "ini", "cfg", "env", "xml", "html", "css",
    "sh", "ps1", "bat", "gradle", "properties", "svelte", "vue", "go", "rs", "php", "rb", "c", "cpp", "h",
];

/// 올리지 않을 이유(크기·비밀) — 없으면 None
fn skip_reason(path: &Path) -> Option<&'static str> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > BIG {
        return Some("50MB 넘음");
    }
    let name = path.file_name()?.to_string_lossy();
    if secret_name(&name) {
        return Some("비밀 파일");
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if TEXT_EXT.contains(&ext.as_str()) && meta.len() <= 2 * 1024 * 1024 {
        if let Ok(b) = std::fs::read(path) {
            if secret_text(&String::from_utf8_lossy(&b)) {
                return Some("키가 들어 있음");
            }
        }
    }
    None
}

/// 커밋 작성자 이름: git 전역 이름, 없으면 noreply 주소의 아이디(`id+아이디@…`), 그것도 없으면 "팀"
pub fn author_name(git_name: Option<String>, email: &str) -> String {
    if let Some(n) = git_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return n;
    }
    email
        .split('@')
        .next()
        .and_then(|l| l.split('+').nth(1))
        .filter(|s| !s.is_empty())
        .unwrap_or("팀")
        .to_string()
}

/// 한 폴더: 바뀐 것 커밋(작성자 email = GitHub 계정의 noreply 주소) → origin에 올리기
pub fn commit_and_push(dir: &str, name: &str, email: &str) -> GrassResult {
    if !email.contains('@') {
        return GrassResult { status: "error".into(), message: "GitHub 계정 이메일을 몰라요 — gh 로그인 후 다시 시도해 주세요".into(), skipped: vec![] };
    }
    match run(Path::new(dir), name, email) {
        Ok(r) => r,
        Err(e) => GrassResult { status: "error".into(), message: e, skipped: vec![] },
    }
}

fn run(dir: &Path, name: &str, email: &str) -> Result<GrassResult, String> {
    ok(dir, &["rev-parse", "--git-dir"]).map_err(|_| "git 저장소가 아니에요".to_string())?;
    let changed = ok(dir, &["-c", "core.quotepath=false", "ls-files", "-z", "--others", "--modified", "--exclude-standard"])?;
    let mut skipped = vec![];
    for rel in changed.split('\0').filter(|s| !s.is_empty()) {
        if let Some(why) = skip_reason(&dir.join(rel)) {
            skipped.push(format!("{rel} ({why})"));
        }
    }
    if !skipped.is_empty() {
        let ex = dir.join(".git").join("info").join("exclude");
        let _ = std::fs::create_dir_all(ex.parent().unwrap());
        let mut add = String::from("\n# AITermHub 잔디: 50MB 넘는 파일·비밀로 보이는 파일은 올리지 않음\n");
        for s in &skipped {
            let rel = s.rsplit_once(" (").map(|x| x.0).unwrap_or(s);
            add.push('/');
            add.push_str(&rel.replace('[', "\\[").replace(']', "\\]").replace('*', "\\*").replace('?', "\\?"));
            add.push('\n');
        }
        let mut cur = std::fs::read_to_string(&ex).unwrap_or_default();
        cur.push_str(&add);
        std::fs::write(&ex, cur).map_err(|e| e.to_string())?;
    }
    ok(dir, &["add", "-A"])?;
    if git(dir, &["diff", "--cached", "--quiet"])?.status.success() {
        return Ok(GrassResult { status: "clean".into(), message: "바뀐 게 없어요".into(), skipped });
    }
    let today = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let email = format!("user.email={email}");
    let user = format!("user.name={name}");
    ok(dir, &["-c", &email, "-c", &user, "commit", "-q", "-m", &format!("작업 기록 {today}")])?;
    let has_origin = git(dir, &["remote", "get-url", "origin"])?.status.success();
    if !has_origin {
        return Ok(GrassResult { status: "committed".into(), message: "커밋했어요(연결된 GitHub 저장소가 없어 올리지는 않았어요)".into(), skipped });
    }
    let br = ok(dir, &["branch", "--show-current"])?.trim().to_string();
    ok(dir, &["push", "-q", "origin", &format!("HEAD:{br}")]).map_err(|e| format!("커밋했지만 올리지 못했어요: {e}"))?;
    Ok(GrassResult { status: "committed".into(), message: format!("커밋해서 올렸어요({br})"), skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_and_text() {
        for n in [".env", ".env.local", "server.pem", "release.keystore", "credentials-prod.json", "id_rsa", "auth.json"] {
            assert!(secret_name(n), "{n}");
        }
        for n in ["env.ts", "keyboard.cs", "README.md", "auth.ts"] {
            assert!(!secret_name(n), "{n}");
        }
        assert!(secret_text("const k = \"sk-ant-api03-abcdefghijklmnopqrstuvwxyz\";"));
        assert!(secret_text("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(secret_text("aws=AKIAABCDEFGHIJKLMNOP"));
        assert!(!secret_text("let skip = 'sk-'; // 접두어만"));
        assert!(!secret_text("AKIA is a prefix"));
    }

    #[test]
    fn author_name_without_personal_defaults() {
        assert_eq!(author_name(Some("홍길동".into()), "1+gd@users.noreply.github.com"), "홍길동");
        assert_eq!(author_name(Some(" ".into()), "1+gd@users.noreply.github.com"), "gd");
        assert_eq!(author_name(None, "x@y"), "팀");
    }

    #[test]
    fn commits_with_noreply_and_skips_big_and_secret_files() {
        let base = std::env::temp_dir().join(format!("aith-grass-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        ok(&base, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(base.join("a.txt"), "hello").unwrap();
        std::fs::write(base.join(".env"), "TOKEN=x").unwrap();
        std::fs::write(base.join("conf.json"), "{\"k\":\"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"}").unwrap();
        let mail = "1+someone@users.noreply.github.com";
        let r = commit_and_push(base.to_str().unwrap(), "테스트", mail);
        assert_eq!(r.status, "committed", "{}", r.message);
        assert_eq!(r.skipped.len(), 2);
        let files = ok(&base, &["ls-files"]).unwrap();
        assert_eq!(files.trim(), "a.txt");
        assert_eq!(ok(&base, &["log", "-1", "--format=%ae"]).unwrap().trim(), mail);
        // 다음엔 바뀐 게 없다(뺀 파일은 exclude에 적혀 있다)
        assert_eq!(commit_and_push(base.to_str().unwrap(), "테스트", mail).status, "clean");
        // 이메일을 모르면 커밋하지 않는다(잔디에 안 잡히는 커밋을 쌓지 않게)
        std::fs::write(base.join("b.txt"), "x").unwrap();
        assert_eq!(commit_and_push(base.to_str().unwrap(), "테스트", "").status, "error");
        let _ = std::fs::remove_dir_all(&base);
    }
}
