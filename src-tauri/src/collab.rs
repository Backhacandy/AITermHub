// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! AI 회사(협업 모드) 실행기: git 작업 공간 · 작업자 프로세스 · 저장.
//! 조직·티켓·스케줄 판단은 프론트(TypeScript)가 하고, 여기서는 "시키는 일"만 정확히 한다.
//!
//! - 실행 브랜치 `aith/run-<id>`를 통합 작업 공간 `.aith/wt/_main`에 둔다(사용자 브랜치·작업 폴더는 건드리지 않음).
//! - 티켓마다 `.aith/wt/<ticket>`에 브랜치 `aith/<id>/<ticket>`로 격리. 끝나면 바뀐 파일 목록을 돌려주고,
//!   프론트가 소유권을 검사한 뒤 accept(통합 브랜치에 병합) 또는 reject(폐기)를 부른다.
//! - 작업자(claude/codex)는 cmd를 거치지 않고 실행 파일을 직접 실행한다(인자 따옴표 문제 없음).
//!   프롬프트는 stdin, 이벤트는 "collab-event" {key, line}, 끝나면 "collab-done" {key, code}.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const NO_WINDOW: u32 = 0x0800_0000;
const AITH: &str = ".aith";

// ---------------- git ----------------

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {} 실패: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn wt_dir(repo: &Path, name: &str) -> PathBuf {
    repo.join(AITH).join("wt").join(name)
}

/// 저장소 상태: git 저장소인지, 커밋이 있는지, 커밋 안 된 변경이 있는지.
#[derive(Serialize)]
pub struct RepoInfo {
    pub is_git: bool,
    pub has_commit: bool,
    pub dirty: bool,
    pub branch: String,
    pub empty_dir: bool,
}

pub fn repo_info(repo: &Path) -> RepoInfo {
    let empty_dir = std::fs::read_dir(repo)
        .map(|rd| rd.flatten().all(|e| e.file_name() == AITH || e.file_name() == ".git"))
        .unwrap_or(true);
    let is_git = git(repo, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true").unwrap_or(false);
    let has_commit = is_git && git(repo, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let dirty = is_git && git(repo, &["status", "--porcelain"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let branch = git(repo, &["branch", "--show-current"]).map(|s| s.trim().to_string()).unwrap_or_default();
    RepoInfo { is_git, has_commit, dirty, branch, empty_dir }
}

/// `.aith/`를 사용자 .gitignore 대신 .git/info/exclude에 추가.
pub(crate) fn exclude_aith(repo: &Path) -> Result<(), String> {
    let git_dir = git(repo, &["rev-parse", "--git-common-dir"])?;
    let mut p = PathBuf::from(git_dir.trim());
    if p.is_relative() {
        p = repo.join(p);
    }
    let f = p.join("info").join("exclude");
    let cur = std::fs::read_to_string(&f).unwrap_or_default();
    if !cur.lines().any(|l| l.trim() == "/.aith/" || l.trim() == ".aith/") {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        std::fs::write(&f, format!("{cur}{}/.aith/\n", if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 바뀐 파일(추적·미추적·삭제 포함), 저장소 기준 `/` 경로.
pub fn changed_files(dir: &Path) -> Result<Vec<String>, String> {
    let out = git(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut files = Vec::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let (status, path) = entry.split_at(3);
        files.push(path.replace('\\', "/"));
        // 이름 변경(R)·복사(C)는 원래 경로가 다음 항목으로 온다 → 그것도 변경으로 본다
        if status.starts_with('R') || status.starts_with('C') {
            if let Some(orig) = parts.next() {
                files.push(orig.replace('\\', "/"));
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

/// 리뷰용 diff(새 파일 포함). 너무 크면 잘라서 돌려준다.
pub fn ticket_diff(dir: &Path, max: usize) -> Result<String, String> {
    git(dir, &["add", "-A"])?;
    let d = git(dir, &["diff", "--cached", "--no-color", "--find-renames"])?;
    Ok(cut_diff(d, max))
}

fn cut_diff(mut d: String, max: usize) -> String {
    if d.len() > max {
        let mut cut = max;
        while !d.is_char_boundary(cut) {
            cut -= 1;
        }
        d.truncate(cut);
        d.push_str("\n…(diff가 길어 잘림)\n");
    }
    d
}

// ---------------- 원격 팀원(본사·지사, GitHub origin을 통해) ----------------
//
// 본사: 실행 브랜치를 origin에 올리고, 팀원 PR의 head를 `refs/aith/pr/<run>/<ticket>`로 가져와
//       티켓 작업 공간에 스테이징(기존 검사·리뷰 그대로) → 통과하면 실행 브랜치에 합친다(gh pr merge 안 씀).
// 지사: origin의 실행 브랜치(재작업이면 티켓 브랜치)에서 작업 공간을 만들고, 끝나면 티켓 브랜치로 push.


// ---------------- 비교 모드(같은 지시를 Claude·Codex가 각자 작업 공간에서) ----------------

fn cmp_branch(id: &str, side: &str) -> String {
    format!("aith/cmp-{id}/{side}")
}

fn cmp_dir(repo: &Path, id: &str, side: &str) -> PathBuf {
    wt_dir(repo, &format!("cmp-{id}-{side}"))
}

pub const CMP_SIDES: [&str; 2] = ["claude", "codex"];

/// 지금 HEAD에서 두 작업 공간을 만든다. 반환: {claude, codex, dirty}
/// (커밋 안 된 변경은 작업 공간에 들어가지 않으므로 dirty를 알려 화면에서 안내)
pub fn compare_prepare(repo: &Path, id: &str) -> Result<Value, String> {
    if !crate::util::safe_arg(id) {
        return Err("잘못된 비교 id".into());
    }
    let info = repo_info(repo);
    if !info.is_git || !info.has_commit {
        return Err("비교 모드는 커밋이 하나 이상 있는 git 저장소에서만 쓸 수 있어요".into());
    }
    exclude_aith(repo)?;
    let _ = git(repo, &["worktree", "prune"]);
    let mut out = serde_json::Map::new();
    for side in CMP_SIDES {
        compare_discard_side(repo, id, side);
        let dir = cmp_dir(repo, id, side);
        git(repo, &["worktree", "add", "-f", "-b", &cmp_branch(id, side), &dir.to_string_lossy(), "HEAD"])?;
        out.insert(side.into(), json!(dir.to_string_lossy()));
    }
    out.insert("dirty".into(), json!(info.dirty));
    Ok(Value::Object(out))
}

fn compare_discard_side(repo: &Path, id: &str, side: &str) {
    let dir = cmp_dir(repo, id, side);
    let _ = git(repo, &["worktree", "remove", "--force", &dir.to_string_lossy()]);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = git(repo, &["branch", "-D", &cmp_branch(id, side)]);
}

/// 두 작업 공간과 브랜치를 모두 지운다.
pub fn compare_discard(repo: &Path, id: &str) {
    for side in CMP_SIDES {
        compare_discard_side(repo, id, side);
    }
    let _ = git(repo, &["worktree", "prune"]);
}

/// 고른 쪽 결과를 지금 브랜치에 커밋 하나로 합치고(squash) 두 작업 공간을 정리. 커밋 해시 반환.
pub fn compare_accept(repo: &Path, id: &str, side: &str, message: &str) -> Result<String, String> {
    if !CMP_SIDES.contains(&side) {
        return Err("잘못된 선택".into());
    }
    let dir = cmp_dir(repo, id, side);
    git(&dir, &["add", "-A"])?;
    if !git(&dir, &["diff", "--cached", "--name-only"])?.trim().is_empty() {
        git(&dir, &["-c", "user.email=aith@local", "-c", "user.name=AITermHub", "commit", "-q", "-m", message])?;
    }
    if git(repo, &["diff", "--quiet", "HEAD", &cmp_branch(id, side)]).is_ok() {
        return Err("고른 쪽에 바뀐 내용이 없어요".into());
    }
    if let Err(e) = git(repo, &["merge", "--squash", &cmp_branch(id, side)]) {
        let _ = git(repo, &["reset", "--merge"]);
        return Err(format!("합치지 못했어요(커밋 안 된 변경이 겹치거나 충돌): {e}"));
    }
    // 사용자 git 정보가 없으면 허브 이름으로 커밋
    let has_user = git(repo, &["config", "user.email"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let commit = if has_user {
        git(repo, &["commit", "-q", "-m", message])
    } else {
        git(repo, &["-c", "user.email=aith@local", "-c", "user.name=AITermHub", "commit", "-q", "-m", message])
    };
    if let Err(e) = commit {
        let _ = git(repo, &["reset", "--merge"]);
        return Err(e);
    }
    let head = git(repo, &["rev-parse", "--short", "HEAD"])?;
    compare_discard(repo, id);
    Ok(head.trim().to_string())
}

// ---------------- 저장 ----------------

// ---------------- 작업자 실행 ----------------

/// npm 전역 shim(claude.cmd·codex.cmd)이 가리키는 실제 실행 파일을 찾는다.
/// 반환: (실행 파일, 앞에 붙일 인자) — codex는 node로 js를 실행.
pub(crate) fn resolve_cli(name: &str) -> (String, Vec<String>) {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(';').filter(|d| !d.is_empty()) {
        let shim = Path::new(dir).join(format!("{name}.cmd"));
        let Ok(text) = std::fs::read_to_string(&shim) else { continue };
        for cand in text.split('"') {
            if let Some(rel) = cand.strip_prefix("%dp0%\\") {
                let target = Path::new(dir).join(rel);
                if !target.exists() {
                    continue;
                }
                let t = target.to_string_lossy().into_owned();
                if t.to_lowercase().ends_with(".exe") {
                    return (t, vec![]);
                }
                if t.to_lowercase().ends_with(".js") {
                    return ("node".into(), vec![t]);
                }
            }
        }
    }
    // 못 찾으면 cmd를 거친다(인자에 특수문자가 없도록 호출 측에서 주의)
    ("cmd".into(), vec!["/C".into(), name.into()])
}

#[derive(Deserialize)]
pub struct WorkerSpec {
    /// 이벤트 구분용 키(예: "run1:T-031")
    pub key: String,
    /// "claude" | "codex"
    pub cli: String,
    pub model: String,
    pub cwd: String,
    pub prompt: String,
    /// Claude: 짧은 역할 지시(기본 시스템 프롬프트 대체 — 맥락 절감)
    pub system_prompt: Option<String>,
    /// Claude: 허용 도구(예: "Read,Edit,Write,Glob,Grep")
    pub tools: Option<String>,
    /// 구조화 출력이 필요할 때 JSON 스키마(Claude --json-schema / Codex --output-schema)
    pub json_schema: Option<Value>,
    /// Claude 권한 모드(기본 acceptEdits)
    pub permission: Option<String>,
    /// Codex 샌드박스(기본 workspace-write, 리뷰는 read-only)
    #[serde(default)]
    pub sandbox: Option<String>,
    /// 계정 풀의 계정 id(없으면 기본 로그인)
    #[serde(default)]
    pub account: Option<String>,
    /// account로 풀어낸 실행 환경(백엔드가 채움)
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

struct Proc {
    child: Child,
    pid: u32,
}

#[derive(Default)]
pub struct WorkerManager {
    procs: Mutex<HashMap<String, Proc>>,
}

fn build_args(spec: &WorkerSpec, schema_file: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if spec.cli == "claude" {
        a.extend(
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--setting-sources",
                "project,local",
            ]
            .map(String::from),
        );
        a.push("--model".into());
        a.push(spec.model.clone());
        a.push("--permission-mode".into());
        a.push(spec.permission.clone().unwrap_or_else(|| "acceptEdits".into()));
        a.push("--tools".into());
        a.push(spec.tools.clone().unwrap_or_else(|| "Read,Edit,Write,Glob,Grep".into()));
        if let Some(sp) = &spec.system_prompt {
            a.push("--system-prompt".into());
            a.push(sp.clone());
        }
        if a.iter().any(|x| x.contains("Bash")) {
            a.push("--append-system-prompt".into());
            a.push(crate::tools::AGENT_HINT.into());
        }
        if let Some(s) = &spec.json_schema {
            a.push("--json-schema".into());
            a.push(s.to_string());
        }
    } else {
        a.extend(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"].map(String::from));
        a.push("-m".into());
        a.push(spec.model.clone());
        let sandbox = match spec.sandbox.as_deref() {
            Some("read-only") => "read-only",
            Some("danger-full-access") => "danger-full-access",
            _ => "workspace-write",
        };
        a.push("-c".into());
        a.push(format!("sandbox_mode={sandbox}"));
        if sandbox != "read-only" {
            a.push("-c".into());
            a.push(format!("developer_instructions='''{}'''", crate::tools::AGENT_HINT));
        }
        a.push("-c".into());
        a.push("approval_policy=never".into());
        if let Some(f) = schema_file {
            a.push("--output-schema".into());
            a.push(f.to_string_lossy().into_owned());
        }
        a.push("-".into());
    }
    a
}

impl WorkerManager {
    /// 작업자 실행(즉시 반환). 이벤트는 collab-event, 종료는 collab-done.
    pub fn spawn(&self, app: &AppHandle, spec: WorkerSpec) -> Result<u32, String> {
        if spec.cli != "claude" && spec.cli != "codex" {
            return Err(format!("알 수 없는 CLI: {}", spec.cli));
        }
        if !crate::util::safe_arg(&spec.model) {
            return Err(format!("모델 이름 형식 오류: {}", spec.model));
        }
        self.kill(&spec.key);

        // Codex 구조화 출력은 스키마 파일로
        let schema_file = match (&spec.cli[..], &spec.json_schema) {
            ("codex", Some(s)) => {
                let f = std::env::temp_dir().join(format!("aith-schema-{}.json", spec.key.replace([':', '/', '\\'], "_")));
                std::fs::write(&f, s.to_string()).map_err(|e| e.to_string())?;
                Some(f)
            }
            _ => None,
        };

        let (exe, mut pre) = resolve_cli(&spec.cli);
        pre.extend(build_args(&spec, schema_file.as_deref()));
        let mut cmd = Command::new(&exe);
        cmd.args(&pre)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(NO_WINDOW);
        for k in ["CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| format!("{} 실행 실패: {e}", spec.cli))?;
        let pid = child.id();
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(spec.prompt.as_bytes());
        }
        let stdout = child.stdout.take().ok_or("stdout 없음")?;
        let stderr = child.stderr.take();

        let key = spec.key.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app2.emit("collab-event", json!({ "key": key, "line": line }));
                }
            }
            let _ = app2.emit("collab-done", json!({ "key": key }));
        });
        if let Some(serr) = stderr {
            let key = spec.key.clone();
            let app3 = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(serr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        let _ = app3.emit("collab-stderr", json!({ "key": key, "line": line }));
                    }
                }
            });
        }
        self.procs.lock().unwrap().insert(spec.key, Proc { child, pid });
        Ok(pid)
    }

    pub fn kill(&self, key: &str) {
        let p = self.procs.lock().unwrap().remove(key);
        if let Some(mut p) = p {
            crate::procctl::kill_tree(p.pid);
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }

    pub fn kill_all(&self) {
        let keys: Vec<String> = self.procs.lock().unwrap().keys().cloned().collect();
        for k in keys {
            self.kill(&k);
        }
    }

    /// 끝난 프로세스 정리(collab-done 이후 프론트가 호출).
    pub fn reap(&self, key: &str) {
        let p = self.procs.lock().unwrap().remove(key);
        if let Some(mut p) = p {
            let _ = p.child.wait();
        }
    }

    /// 실행 중인 작업자 메모리(사무실 화면 표시용).
    /// 실행 중 작업자 수(앱 종료 확인용)
    pub fn count(&self) -> usize {
        self.procs.lock().unwrap().len()
    }

}

// ---------------- 테스트 실행(모델 없이) ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aith-collab-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn compare_two_sides_and_accept_one() {
        let repo = temp_repo("cmp");
        git(&repo, &["init", "-q"]).unwrap();
        std::fs::write(repo.join("a.txt"), "1\n").unwrap();
        git(&repo, &["add", "-A"]).unwrap();
        git(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]).unwrap();
        let p = compare_prepare(&repo, "c1").unwrap();
        let (cl, cx) = (p["claude"].as_str().unwrap().to_string(), p["codex"].as_str().unwrap().to_string());
        std::fs::write(Path::new(&cl).join("a.txt"), "claude\n").unwrap();
        std::fs::write(Path::new(&cx).join("b.txt"), "codex\n").unwrap();
        assert!(ticket_diff(Path::new(&cx), 10_000).unwrap().contains("+codex"));
        compare_accept(&repo, "c1", "codex", "비교: Codex 결과").unwrap();
        // Windows git(autocrlf)는 체크아웃 때 줄바꿈을 CRLF로 바꿀 수 있다
        assert_eq!(std::fs::read_to_string(repo.join("b.txt")).unwrap().trim_end(), "codex");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap().trim_end(), "1");
        assert!(!Path::new(&cl).exists() && !Path::new(&cx).exists());
        assert!(git(&repo, &["rev-parse", "--verify", "aith/cmp-c1/claude"]).is_err());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn compare_needs_git_repo() {
        let dir = temp_repo("cmp-nogit");
        assert!(compare_prepare(&dir, "c2").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_args_are_minimal_and_direct() {
        let spec = WorkerSpec {
            key: "k".into(),
            cli: "claude".into(),
            model: "haiku".into(),
            cwd: ".".into(),
            prompt: "x".into(),
            system_prompt: Some("역할: \"작업자\" & 규칙".into()),
            tools: None,
            json_schema: Some(json!({ "type": "object" })),
            permission: None,
            sandbox: None,
            account: None,
            env: vec![],
        };
        let a = build_args(&spec, None);
        for must in ["--strict-mcp-config", "--no-session-persistence", "--setting-sources", "--tools", "--system-prompt", "--json-schema"] {
            assert!(a.iter().any(|x| x == must), "{must}");
        }
        // 특수문자가 있어도 인자 하나로 그대로 전달(cmd를 거치지 않으므로)
        assert!(a.iter().any(|x| x == "역할: \"작업자\" & 규칙"));
    }

    #[test]
    fn resolves_real_cli_executables_without_cmd() {
        // 이 PC에 설치된 npm 전역 shim에서 실제 실행 파일을 찾는다(설치 안 된 환경이면 cmd 대체로 통과)
        let (exe, pre) = resolve_cli("claude");
        if exe != "cmd" {
            assert!(exe.to_lowercase().ends_with(".exe") && Path::new(&exe).exists(), "{exe}");
            assert!(pre.is_empty());
        }
        let (exe, pre) = resolve_cli("codex");
        if exe != "cmd" {
            assert_eq!(exe, "node");
            assert!(pre[0].to_lowercase().ends_with("codex.js") && Path::new(&pre[0]).exists(), "{pre:?}");
        }
    }

    #[test]
    fn codex_args_ignore_user_config() {
        let spec = WorkerSpec {
            key: "k".into(),
            cli: "codex".into(),
            model: "gpt-6-luna".into(),
            cwd: ".".into(),
            prompt: "x".into(),
            system_prompt: None,
            tools: None,
            json_schema: None,
            permission: None,
            sandbox: Some("read-only".into()),
            account: None,
            env: vec![],
        };
        let a = build_args(&spec, None);
        assert!(a.contains(&"--ignore-user-config".to_string()));
        assert!(a.contains(&"--ephemeral".to_string()));
        assert_eq!(a.last().unwrap(), "-");
        assert!(a.contains(&"sandbox_mode=read-only".to_string()));
    }
}
