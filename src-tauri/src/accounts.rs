// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 계정 풀: Claude/Codex 유료 계정 여러 개를 등록해 두고, 5시간·주간 한도가 차면 다음 계정으로 넘어간다.
//!
//! - 기본 계정(`home: None`)은 지금 PC에 로그인된 계정 — 환경변수 없이 실행.
//! - 추가 계정은 전용 폴더(app_data_dir/accounts/<id>)를 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`으로 쓴다.
//!   대화 기록·스킬 폴더는 원래 위치로 junction을 걸어 두므로 계정을 바꿔도 지난 기억이 그대로 이어진다.
//! - 배열 순서 = 사용 우선순위.
//! - 한도: Codex는 `codex app-server`의 account/rateLimits/read(토큰 0),
//!   Claude는 `/usage`(로컬 명령 — 토큰 0), 실사용 중 rate_limit_event는 프론트가 `note`로 알려준다.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    /// "claude" | "codex"
    pub cli: String,
    /// 전용 설정 폴더. None = 기본 로그인
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub logged_in: bool,
    /// `{ five?: {pct, resetsAt}, week?: {pct, resetsAt}, checkedAt }` — pct는 사용률(0~100), resetsAt은 초 단위 epoch
    #[serde(default)]
    pub limits: Option<Value>,
    /// 한도 소진으로 이 시각(초)까지 건너뜀
    #[serde(default)]
    pub exhausted_until: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    /// 사용자가 "이 계정으로 전환"한 계정(CLI마다 하나) — 우선순위보다 먼저 쓴다
    #[serde(default)]
    pub active: bool,
}

fn yes() -> bool {
    true
}

static CACHE: Mutex<Option<Vec<Account>>> = Mutex::new(None);

pub fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn load_raw(app: &AppHandle) -> Vec<Account> {
    if let Some(v) = CACHE.lock().unwrap().as_ref() {
        return v.clone();
    }
    let v: Vec<Account> = root(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("accounts.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    *CACHE.lock().unwrap() = Some(v.clone());
    v
}

fn store(app: &AppHandle, list: &[Account]) -> Result<(), String> {
    let d = root(app)?;
    std::fs::write(d.join("accounts.json"), serde_json::to_string_pretty(list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    *CACHE.lock().unwrap() = Some(list.to_vec());
    Ok(())
}

fn update<F: FnOnce(&mut Vec<Account>) -> Result<(), String>>(app: &AppHandle, f: F) -> Result<Vec<Account>, String> {
    let mut list = load_raw(app);
    f(&mut list)?;
    store(app, &list)?;
    Ok(list)
}

// ---------- 순수 규칙(테스트 대상) ----------

/// 이 계정이 지금 한도 때문에 쓸 수 없는지
pub fn is_exhausted(a: &Account, now: i64) -> bool {
    a.exhausted_until.map(|u| u > now).unwrap_or(false) || limits_exhausted(a, now)
}

/// 사용량(5시간·주간)만 보고 찬 창이 아직 안 풀렸는지 — 새 사용량을 받았을 때 막아 둔 표시(exhausted_until)를 풀지 정한다.
/// (막아 둔 표시까지 함께 보면, 한 번 막힌 계정은 새 사용량이 "괜찮다"고 해도 그 시각까지 풀리지 않는다)
pub fn limits_exhausted(a: &Account, now: i64) -> bool {
    let Some(l) = &a.limits else { return false };
    ["five", "week"].iter().any(|k| {
        let w = &l[*k];
        let pct = w["pct"].as_f64().unwrap_or(0.0);
        let reset = w["resetsAt"].as_i64().unwrap_or(0);
        pct >= 100.0 && (reset == 0 || reset > now)
    })
}

/// 직접 고른 계정(쓸 수 있으면) → 켜진 계정 중 순서대로 소진 아닌 첫 계정 → 전부 소진이면 가장 빨리 풀리는 계정.
/// 켜진 게 없으면 None.
pub fn pick(list: &[Account], cli: &str, now: i64) -> Option<String> {
    let on: Vec<&Account> = list.iter().filter(|a| a.cli == cli && a.enabled && a.logged_in).collect();
    if let Some(a) = on.iter().find(|a| a.active && !is_exhausted(a, now)) {
        return Some(a.id.clone());
    }
    if let Some(a) = on.iter().find(|a| !is_exhausted(a, now)) {
        return Some(a.id.clone());
    }
    on.iter()
        .min_by_key(|a| reset_at(a).unwrap_or(i64::MAX))
        .map(|a| a.id.clone())
}

fn reset_at(a: &Account) -> Option<i64> {
    let mut best = a.exhausted_until;
    if let Some(l) = &a.limits {
        for k in ["five", "week"] {
            if l[k]["pct"].as_f64().unwrap_or(0.0) >= 100.0 {
                if let Some(r) = l[k]["resetsAt"].as_i64() {
                    best = Some(best.map_or(r, |b| b.max(r)));
                }
            }
        }
    }
    best
}

/// 끌 수 있는지: 같은 CLI에 켜진 계정이 최소 하나는 남아야 한다
pub fn can_disable(list: &[Account], id: &str) -> bool {
    let Some(a) = list.iter().find(|a| a.id == id) else { return false };
    list.iter().filter(|x| x.cli == a.cli && x.enabled && x.id != id).count() > 0
}

/// `codex app-server` account/rateLimits/read 결과 → 정규화된 한도(창 길이로 5시간/주간 구분)
pub fn parse_codex_limits(res: &Value) -> Value {
    let rl = &res["rateLimits"];
    let mut out = json!({ "checkedAt": now_s() });
    for k in ["primary", "secondary"] {
        let w = &rl[k];
        if !w.is_object() {
            continue;
        }
        let mins = w["windowDurationMins"].as_i64().unwrap_or(0);
        let slot = if mins > 0 && mins <= 24 * 60 { "five" } else { "week" };
        out[slot] = json!({ "pct": w["usedPercent"].as_f64().unwrap_or(0.0), "resetsAt": w["resetsAt"].as_i64() });
    }
    if rl["rateLimitReachedType"].is_string() {
        out["reached"] = json!(true);
    }
    out
}

/// Claude `rate_limit_event` → 정규화된 한도(utilization 0~1 → %)
pub fn parse_claude_limit_event(ev: &Value) -> Option<Value> {
    let info = ev.get("rate_limit_info")?;
    let wins = &info["unifiedWindows"];
    let mut out = json!({ "checkedAt": now_s() });
    for (src, dst) in [("five_hour", "five"), ("seven_day", "week")] {
        let w = &wins[src];
        if let Some(u) = w["utilization"].as_f64() {
            out[dst] = json!({ "pct": (u * 1000.0).round() / 10.0, "resetsAt": w["resetsAt"].as_i64() });
        }
    }
    if info["status"].as_str() == Some("rejected") {
        let t = info["rateLimitType"].as_str().unwrap_or("five_hour");
        let dst = if t.starts_with("seven") { "week" } else { "five" };
        out[dst]["pct"] = json!(100.0);
        if out[dst]["resetsAt"].is_null() {
            out[dst]["resetsAt"] = info["resetsAt"].clone();
        }
    }
    Some(out)
}

// ---------- 폴더 연결 ----------

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

/// 원래 설정 폴더(~/.claude, ~/.codex)
fn source_dir(cli: &str) -> PathBuf {
    if cli == "codex" {
        if let Ok(h) = std::env::var("CODEX_HOME") {
            if !h.is_empty() {
                return PathBuf::from(h);
            }
        }
        home_dir().join(".codex")
    } else {
        home_dir().join(".claude")
    }
}

/// junction으로 공유할 폴더(대화 기록·스킬 등)와 실행 때 복사할 파일
fn shared(cli: &str) -> (&'static [&'static str], &'static [&'static str]) {
    if cli == "codex" {
        (&["sessions", "skills", "rules"], &["config.toml", "AGENTS.md"])
    } else {
        (&["projects", "skills", "agents", "commands", "plugins", "todos"], &["settings.json", "CLAUDE.md"])
    }
}

/// 계정 폴더를 준비: 공유 폴더 junction(관리자 권한 불필요) + 설정 파일 복사
pub fn prepare_home(home: &Path, src: &Path, cli: &str) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let (dirs, _) = shared(cli);
    for d in dirs {
        let target = src.join(d);
        let link = home.join(d);
        if link.exists() || std::fs::symlink_metadata(&link).is_ok() {
            continue;
        }
        // 대화 기록 폴더는 아직 없어도 만들어서 연결(이후 기록이 원래 위치에 쌓이게)
        if !target.exists() {
            if *d == "projects" || *d == "sessions" {
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else {
                continue;
            }
        }
        let out = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags_no_window()
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("{d} 폴더 연결 실패"));
        }
    }
    sync_files(home, src, cli);
    Ok(())
}

/// 원래 설정 파일이 더 새로우면 계정 폴더로 복사(설정·지침을 계정 간에 맞춘다)
pub fn sync_files(home: &Path, src: &Path, cli: &str) {
    let (_, files) = shared(cli);
    for f in files {
        let s = src.join(f);
        let d = home.join(f);
        let newer = match (std::fs::metadata(&s).and_then(|m| m.modified()), std::fs::metadata(&d).and_then(|m| m.modified())) {
            (Ok(a), Ok(b)) => a > b,
            (Ok(_), Err(_)) => true,
            _ => false,
        };
        if newer {
            let _ = std::fs::copy(&s, &d);
        }
    }
}

/// 계정 폴더 삭제: junction은 링크만 지우고(원본 보존) 나머지를 지운다
fn remove_home(home: &Path, cli: &str) {
    let (dirs, _) = shared(cli);
    for d in dirs {
        let link = home.join(d);
        if std::fs::symlink_metadata(&link).is_ok() {
            let _ = std::fs::remove_dir(&link);
        }
    }
    let _ = std::fs::remove_dir_all(home);
}

trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(NO_WINDOW)
    }
}

// ---------- 실행 환경 ----------

fn env_key(cli: &str) -> &'static str {
    if cli == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    }
}

fn env_of(a: &Account) -> Vec<(String, String)> {
    match &a.home {
        Some(h) => {
            sync_files(Path::new(h), &source_dir(&a.cli), &a.cli);
            vec![(env_key(&a.cli).to_string(), h.clone())]
        }
        None => vec![],
    }
}

/// 계정 id → 실행 환경변수(기본 계정/없는 id는 빈 목록)
pub fn env_for(app: &AppHandle, id: Option<&str>) -> Vec<(String, String)> {
    let Some(id) = id.filter(|s| !s.is_empty()) else { return vec![] };
    load_raw(app).iter().find(|a| a.id == id).map(env_of).unwrap_or_default()
}

fn base_cmd(cli: &str, env: &[(String, String)]) -> Command {
    let (exe, pre) = crate::collab::resolve_cli(cli);
    let mut cmd = Command::new(exe);
    cmd.args(pre).creation_flags_no_window();
    for k in ["CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

/// 출력 줄을 읽으며 `done`이 true를 낼 때까지(또는 시간 초과) 기다린다
/// `keep_open`: app-server처럼 stdin이 닫히면 끝나는 프로그램은 결과를 받을 때까지 열어 둔다.
fn read_lines_until<F: FnMut(&Value) -> bool>(mut cmd: Command, input: &[u8], keep_open: bool, timeout: Duration, mut done: F) -> Result<(), String> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(input);
        if keep_open {
            std::thread::spawn(move || {
                std::thread::sleep(timeout);
                drop(si);
            });
        }
    }
    let out = child.stdout.take().ok_or("stdout 없음")?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let start = Instant::now();
    let mut ok = false;
    while start.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(v) => {
                if done(&v) {
                    ok = true;
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    crate::procctl::kill_tree(pid);
    let _ = child.wait();
    if ok {
        Ok(())
    } else {
        Err("응답 시간 초과".into())
    }
}

/// Codex: app-server로 계정 정보와 한도를 읽는다(토큰 0)
fn refresh_codex(env: &[(String, String)]) -> Result<(Option<String>, Option<String>, Value), String> {
    let mut cmd = base_cmd("codex", env);
    cmd.arg("app-server");
    let input = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"aitermhub","version":"0.1"}}}),
        json!({"jsonrpc":"2.0","method":"initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}),
        json!({"jsonrpc":"2.0","id":3,"method":"account/rateLimits/read"}),
    ]
    .iter()
    .map(|v| v.to_string() + "\n")
    .collect::<String>();
    let mut account: Option<Value> = None;
    let mut limits: Option<Value> = None;
    let mut err: Option<String> = None;
    read_lines_until(cmd, input.as_bytes(), true, Duration::from_secs(25), |v| {
        match v["id"].as_i64() {
            Some(2) => account = Some(v["result"]["account"].clone()),
            Some(3) => {
                if v["error"].is_object() {
                    err = v["error"]["message"].as_str().map(String::from);
                    limits = Some(Value::Null);
                } else {
                    limits = Some(parse_codex_limits(&v["result"]));
                }
            }
            _ => {}
        }
        account.is_some() && limits.is_some()
    })?;
    let acc = account.unwrap_or(Value::Null);
    if acc.is_null() {
        return Err(err.unwrap_or_else(|| "로그인 필요".into()));
    }
    Ok((
        acc["email"].as_str().map(String::from),
        acc["planType"].as_str().map(String::from),
        limits.unwrap_or(Value::Null),
    ))
}

/// Claude: `claude auth status`로 이메일·요금제
fn claude_status(env: &[(String, String)]) -> Result<(bool, Option<String>, Option<String>), String> {
    let mut cmd = base_cmd("claude", env);
    cmd.args(["auth", "status", "--json"]).stdin(Stdio::null());
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| "로그인 상태를 읽지 못했어요".to_string())?;
    Ok((
        v["loggedIn"].as_bool().unwrap_or(false),
        v["email"].as_str().map(String::from),
        v["subscriptionType"].as_str().map(String::from),
    ))
}

/// Claude: `/usage`를 한 번 실행해 한도를 읽는다. 로컬 명령이라 모델을 부르지 않는다(토큰 0).
/// 출력 예: "Current session: 62% used · resets Oct 19, 6:30pm (Asia/Seoul)"
fn claude_probe(env: &[(String, String)]) -> Result<Value, String> {
    let mut cmd = base_cmd("claude", env);
    cmd.args([
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--tools",
        "",
        // 혹시 모델로 넘어가더라도 가장 가볍게
        "--model",
        "haiku",
        "--system-prompt",
        "x",
    ])
    .stdin(Stdio::null());
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| "한도를 읽지 못했어요".to_string())?;
    let body = v["result"].as_str().unwrap_or("");
    let lim = parse_usage_text(body, chrono::Local::now());
    if lim.get("five").is_none() && lim.get("week").is_none() {
        return Err(if body.to_lowercase().contains("api key") { "API 키 로그인은 한도가 없어요".into() } else { "한도를 읽지 못했어요".into() });
    }
    Ok(lim)
}

/// `/usage` 출력 → 정규화된 한도. 재설정 시각은 이 PC 시간대 기준 텍스트("Oct 19, 6:30pm")를 epoch 초로.
pub fn parse_usage_text(text: &str, now: chrono::DateTime<chrono::Local>) -> Value {
    let mut out = json!({ "checkedAt": now.timestamp() });
    for line in text.lines() {
        let l = line.trim();
        let slot = if l.starts_with("Current session") {
            "five"
        } else if l.starts_with("Current week (all models)") || (l.starts_with("Current week") && out.get("week").is_none() && !l.contains('(')) {
            "week"
        } else {
            continue;
        };
        let Some(pi) = l.find("% used") else { continue };
        let num: String = l[..pi].chars().rev().take_while(|c| c.is_ascii_digit() || *c == '.').collect::<Vec<_>>().into_iter().rev().collect();
        let Ok(pct) = num.parse::<f64>() else { continue };
        let reset = l
            .find("resets ")
            .map(|i| &l[i + 7..])
            .map(|r| r.split(" (").next().unwrap_or(r).trim())
            .and_then(|r| parse_reset(r, now));
        out[slot] = json!({ "pct": pct, "resetsAt": reset });
    }
    out
}

/// "Oct 19, 6:30pm" / "Oct 24, 3am" / "6:30pm" / "Oct 24" → epoch 초(지난 시각이면 다음 날/해로)
fn parse_reset(s: &str, now: chrono::DateTime<chrono::Local>) -> Option<i64> {
    use chrono::{Datelike, Duration as CD, NaiveDate, NaiveTime, TimeZone};
    let parts: Vec<&str> = s.split(',').map(|x| x.trim()).collect();
    let (date_s, time_s) = match parts.as_slice() {
        [d, t] => (Some(*d), Some(*t)),
        [one] if one.chars().any(|c| c.is_ascii_digit()) && (one.ends_with("am") || one.ends_with("pm") || one.contains(':')) => (None, Some(*one)),
        [one] => (Some(*one), None),
        _ => return None,
    };
    let time = match time_s {
        Some(t) => {
            let t = t.to_lowercase();
            let (core, pm) = if let Some(x) = t.strip_suffix("pm") { (x.trim().to_string(), Some(true)) } else if let Some(x) = t.strip_suffix("am") { (x.trim().to_string(), Some(false)) } else { (t.clone(), None) };
            let mut hm = core.split(':');
            let mut h: u32 = hm.next()?.trim().parse().ok()?;
            let m: u32 = hm.next().map(|x| x.trim().parse().ok()).unwrap_or(Some(0))?;
            match pm {
                Some(true) if h < 12 => h += 12,
                Some(false) if h == 12 => h = 0,
                _ => {}
            }
            NaiveTime::from_hms_opt(h, m, 0)?
        }
        None => NaiveTime::from_hms_opt(0, 0, 0)?,
    };
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let mut date = match date_s {
        Some(d) => {
            let mut it = d.split_whitespace();
            let mon = it.next()?.to_lowercase();
            let month = MONTHS.iter().position(|m| mon.starts_with(m))? as u32 + 1;
            let day: u32 = it.next()?.parse().ok()?;
            let mut nd = NaiveDate::from_ymd_opt(now.year(), month, day)?;
            // 연말에 "Jan 2"처럼 넘어가는 경우
            if nd < now.date_naive() - CD::days(1) {
                nd = NaiveDate::from_ymd_opt(now.year() + 1, month, day)?;
            }
            nd
        }
        None => now.date_naive(),
    };
    let mut dt = chrono::Local.from_local_datetime(&date.and_time(time)).earliest()?;
    if date_s.is_none() && dt < now {
        date = date.succ_opt()?;
        dt = chrono::Local.from_local_datetime(&date.and_time(time)).earliest()?;
    }
    Some(dt.timestamp())
}

// ---------- 명령 ----------

/// 목록. 기본 계정이 없으면 감지해서 맨 앞에 넣는다(로그인 안 돼 있으면 넣지 않음).
pub fn list(app: &AppHandle) -> Vec<Account> {
    let mut list = load_raw(app);
    let mut changed = false;
    for cli in ["claude", "codex"] {
        if list.iter().any(|a| a.cli == cli && a.home.is_none()) {
            continue;
        }
        let mut a = Account {
            id: format!("{cli}-default"),
            cli: cli.into(),
            home: None,
            email: None,
            plan: None,
            enabled: true,
            logged_in: false,
            limits: None,
            exhausted_until: None,
            error: None,
            active: false,
        };
        let ok = if cli == "claude" {
            claude_status(&[]).map(|(li, e, p)| {
                a.logged_in = li;
                a.email = e;
                a.plan = p;
            })
        } else {
            refresh_codex(&[]).map(|(e, p, l)| {
                a.logged_in = true;
                a.email = e;
                a.plan = p;
                a.limits = Some(l).filter(|l| !l.is_null());
            })
        };
        if ok.is_ok() && a.logged_in {
            let pos = list.iter().position(|x| x.cli == cli).unwrap_or(list.len());
            list.insert(pos, a);
            changed = true;
        }
    }
    if changed {
        let _ = store(app, &list);
    }
    list
}

pub fn add(app: &AppHandle, cli: &str) -> Result<Account, String> {
    crate::util::one_of(cli, &["claude", "codex"])?;
    let id = format!("{cli}-{}", now_s());
    let home = root(app)?.join("accounts").join(&id);
    prepare_home(&home, &source_dir(cli), cli)?;
    let a = Account {
        id,
        cli: cli.into(),
        home: Some(home.to_string_lossy().into_owned()),
        email: None,
        plan: None,
        enabled: true,
        logged_in: false,
        limits: None,
        exhausted_until: None,
        error: Some("로그인 필요".into()),
        active: false,
    };
    let a2 = a.clone();
    update(app, move |l| {
        l.push(a2);
        Ok(())
    })?;
    Ok(a)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<Vec<Account>, String> {
    let list = load_raw(app);
    let a = list.iter().find(|a| a.id == id).ok_or("계정 없음")?.clone();
    let Some(home) = &a.home else { return Err("기본 로그인 계정은 지울 수 없어요".into()) };
    if a.enabled && !can_disable(&list, id) {
        return Err("켜진 계정이 최소 하나는 남아야 해요".into());
    }
    remove_home(Path::new(home), &a.cli);
    update(app, |l| {
        l.retain(|x| x.id != id);
        Ok(())
    })
}

/// 우선순위 변경: ids 순서대로 정렬(목록에 없는 계정은 뒤에 원래 순서로)
pub fn set_order(app: &AppHandle, ids: Vec<String>) -> Result<Vec<Account>, String> {
    update(app, |l| {
        l.sort_by_key(|a| ids.iter().position(|x| *x == a.id).unwrap_or(usize::MAX));
        Ok(())
    })
}

pub fn set_enabled(app: &AppHandle, id: &str, on: bool) -> Result<Vec<Account>, String> {
    update(app, |l| {
        if !on && !can_disable(l, id) {
            return Err("켜진 계정이 최소 하나는 남아야 해요".into());
        }
        let a = l.iter_mut().find(|a| a.id == id).ok_or("계정 없음")?;
        a.enabled = on;
        Ok(())
    })
}

/// 같은 CLI에 같은 이메일로 로그인된 카드들(예: 기본 로그인을 바꿔서 추가 계정과 겹친 경우)의 id
pub fn same_account(list: &[Account], id: &str) -> Vec<String> {
    let Some(a) = list.iter().find(|a| a.id == id) else { return vec![] };
    match a.email.as_deref().filter(|e| !e.is_empty()) {
        Some(email) => list
            .iter()
            .filter(|x| x.cli == a.cli && x.email.as_deref() == Some(email))
            .map(|x| x.id.clone())
            .collect(),
        None => vec![a.id.clone()],
    }
}

/// 새로고침에서 읽은 이메일이 이 카드의 계정과 다르면 그 이유(카드를 바꾸지 않는다).
/// - 추가 카드는 처음 로그인한 계정에 고정: 다시 로그인할 때 브라우저에 로그인돼 있던 다른 계정으로
///   승인되면 카드가 슬그머니 그 계정으로 바뀌어 "같은 계정"을 두 번 쓰게 된다.
/// - 새 카드가 이미 등록된 계정으로 로그인돼도 거부.
/// - 기본 카드(home 없음)는 이 PC의 로그인을 그대로 따른다.
pub fn identity_conflict(list: &[Account], id: &str, new_email: Option<&str>) -> Option<String> {
    let a = list.iter().find(|a| a.id == id)?;
    let new = new_email.filter(|e| !e.is_empty())?;
    a.home.as_ref()?;
    let same = |x: &str| x.eq_ignore_ascii_case(new);
    match a.email.as_deref().filter(|e| !e.is_empty()) {
        Some(old) if !same(old) => Some(format!(
            "{new} 계정으로 로그인돼 있어요(이 카드는 {old}). 브라우저에서 {old}로 바꾼 뒤 다시 로그인하세요"
        )),
        Some(_) => None,
        None => list
            .iter()
            .any(|x| x.id != id && x.cli == a.cli && x.email.as_deref().is_some_and(same))
            .then(|| format!("이미 등록된 {new} 계정으로 로그인됐어요. 브라우저에서 추가할 계정으로 바꾼 뒤 다시 로그인하세요")),
    }
}

/// cmd 줄에 그대로 넣어도 되는 이메일인지(공백·셸 특수문자 없음)
fn is_plain_email(e: &str) -> bool {
    e.contains('@') && e.chars().all(|c| c.is_ascii_alphanumeric() || "@._+-".contains(c))
}

/// 실행 중에 받은 한도(프론트가 rate_limit_event / codex 턴 결과로 알려줌) — 같은 계정 카드에 모두 반영
pub fn note(app: &AppHandle, id: &str, limits: Value) -> Result<Vec<Account>, String> {
    update(app, |l| {
        let ids = same_account(l, id);
        for a in l.iter_mut().filter(|a| ids.contains(&a.id)) {
            a.limits = Some(limits.clone());
            if !limits_exhausted(a, now_s()) {
                a.exhausted_until = None;
            }
        }
        Ok(())
    })
}

/// 한도 오류로 실패 → until(초)까지 건너뜀(모르면 1시간)
pub fn exhaust(app: &AppHandle, id: &str, until: Option<i64>) -> Result<Vec<Account>, String> {
    update(app, |l| {
        // 같은 계정이 카드 두 개에 있으면 둘 다 건너뛰어야 같은 계정으로 다시 넘어가지 않는다
        let ids = same_account(l, id);
        let t = until.filter(|u| *u > now_s()).unwrap_or(now_s() + 3600);
        for a in l.iter_mut().filter(|a| ids.contains(&a.id)) {
            a.exhausted_until = Some(t);
        }
        Ok(())
    })
}

/// "이 계정으로 전환": 같은 CLI에서 이 계정만 지정(우선순위 순서는 그대로)
pub fn activate(app: &AppHandle, id: &str) -> Result<Vec<Account>, String> {
    update(app, |l| {
        let a = l.iter().find(|a| a.id == id).ok_or("계정 없음")?.clone();
        if !a.enabled || !a.logged_in {
            return Err("켜져 있고 로그인된 계정만 전환할 수 있어요".into());
        }
        for x in l.iter_mut().filter(|x| x.cli == a.cli) {
            x.active = x.id == id;
        }
        Ok(())
    })
}

pub fn pick_for(app: &AppHandle, cli: &str) -> Option<String> {
    pick(&load_raw(app), cli, now_s())
}

/// 카드 새로고침: 로그인 상태·이메일·요금제·한도
pub fn refresh(app: &AppHandle, id: &str) -> Result<Vec<Account>, String> {
    let all = load_raw(app);
    let a = all.iter().find(|a| a.id == id).cloned().ok_or("계정 없음")?;
    let env = env_of(&a);
    let mut upd = a.clone();
    let conflict = |e: &Option<String>| identity_conflict(&all, id, e.as_deref());
    if a.cli == "codex" {
        match refresh_codex(&env) {
            Ok((e, _, _)) if conflict(&e).is_some() => {
                upd.logged_in = false;
                upd.error = conflict(&e);
            }
            Ok((e, p, l)) => {
                upd.logged_in = true;
                upd.email = e;
                upd.plan = p;
                if !l.is_null() {
                    upd.limits = Some(l);
                }
                upd.error = None;
            }
            Err(e) => {
                upd.logged_in = false;
                upd.error = Some(e);
            }
        }
    } else {
        match claude_status(&env) {
            Ok((true, e, _)) if conflict(&e).is_some() => {
                upd.logged_in = false;
                upd.error = conflict(&e);
            }
            Ok((true, e, p)) => {
                upd.logged_in = true;
                upd.email = e;
                upd.plan = p;
                match claude_probe(&env) {
                    Ok(l) => {
                        upd.limits = Some(l);
                        upd.error = None;
                    }
                    Err(e) => upd.error = Some(e),
                }
            }
            Ok((false, _, _)) => {
                upd.logged_in = false;
                upd.error = Some("로그인 필요".into());
            }
            Err(e) => upd.error = Some(e),
        }
    }
    if !limits_exhausted(&upd, now_s()) {
        upd.exhausted_until = None;
    }
    update(app, |l| {
        if let Some(x) = l.iter_mut().find(|x| x.id == id) {
            *x = upd;
        }
        Ok(())
    })
}

/// 로그인용 터미널 명령(프론트가 터미널 탭으로 띄움)
pub fn login_spec(app: &AppHandle, id: &str) -> Result<Value, String> {
    let a = load_raw(app).into_iter().find(|a| a.id == id).ok_or("계정 없음")?;
    // 다시 로그인하는 카드는 그 계정 이메일을 미리 채워 브라우저에 로그인된 다른 계정으로 바로 승인되지 않게
    let line = match (a.cli.as_str(), a.email.as_deref().filter(|e| a.home.is_some() && is_plain_email(e))) {
        ("codex", _) => "codex login".to_string(),
        (_, Some(e)) => format!("claude auth login --email {e}"),
        _ => "claude auth login".to_string(),
    };
    Ok(json!({ "program": "cmd.exe", "args": ["/k", line], "env": env_of(&a), "cwd": a.home }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(id: &str, cli: &str, enabled: bool) -> Account {
        Account {
            id: id.into(),
            cli: cli.into(),
            home: None,
            email: None,
            plan: None,
            enabled,
            logged_in: true,
            limits: None,
            exhausted_until: None,
            error: None,
            active: false,
        }
    }

    #[test]
    fn pick_follows_order_and_skips_exhausted() {
        let now = 1_000;
        let mut a = acc("a", "claude", true);
        let b = acc("b", "claude", true);
        let c = acc("c", "codex", true);
        assert_eq!(pick(&[a.clone(), b.clone(), c.clone()], "claude", now).as_deref(), Some("a"));
        a.limits = Some(json!({ "five": { "pct": 100.0, "resetsAt": 2_000 } }));
        assert_eq!(pick(&[a.clone(), b.clone(), c.clone()], "claude", now).as_deref(), Some("b"));
        // 재설정 시각이 지나면 다시 쓸 수 있다
        assert_eq!(pick(&[a.clone(), b.clone()], "claude", 3_000).as_deref(), Some("a"));
        // 꺼진 계정·로그인 안 된 계정은 제외
        let mut b2 = b.clone();
        b2.enabled = false;
        assert_eq!(pick(&[a.clone(), b2], "claude", now).as_deref(), Some("a")); // 전부 소진 → 가장 빨리 풀리는 것
        assert_eq!(pick(&[c], "claude", now), None);
    }

    #[test]
    fn extra_card_keeps_its_account() {
        let mut def = acc("d", "claude", true);
        def.email = Some("me@x".into());
        let mut b = acc("b", "claude", true);
        b.home = Some("h".into());
        b.email = Some("other@x".into());
        let l = vec![def.clone(), b.clone()];
        // 다른 계정으로 바뀌면 거부(대소문자 무시)
        assert!(identity_conflict(&l, "b", Some("me@x")).unwrap().contains("me@x"));
        assert_eq!(identity_conflict(&l, "b", Some("Other@X")), None);
        // 기본 카드는 이 PC 로그인을 따른다
        assert_eq!(identity_conflict(&l, "d", Some("new@x")), None);
        // 새 카드가 이미 있는 계정으로 로그인되면 거부
        let mut n = acc("n", "claude", true);
        n.home = Some("h2".into());
        let l2 = vec![def, b, n];
        assert!(identity_conflict(&l2, "n", Some("me@x")).is_some());
        assert_eq!(identity_conflict(&l2, "n", Some("new@x")), None);
        assert_eq!(identity_conflict(&l2, "n", None), None);
    }

    #[test]
    fn active_account_first_unless_exhausted() {
        let now = 1_000;
        let a = acc("a", "claude", true);
        let mut b = acc("b", "claude", true);
        b.active = true;
        assert_eq!(pick(&[a.clone(), b.clone()], "claude", now).as_deref(), Some("b"));
        // 지정 계정이 소진되면 우선순위대로
        b.exhausted_until = Some(2_000);
        assert_eq!(pick(&[a.clone(), b.clone()], "claude", now).as_deref(), Some("a"));
        // 꺼진 지정 계정은 무시
        let mut b2 = acc("b", "claude", false);
        b2.active = true;
        assert_eq!(pick(&[a, b2], "claude", now).as_deref(), Some("a"));
    }

    #[test]
    fn usage_text_parsing() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 10, 19, 16, 0, 0).unwrap();
        let text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 62% used · resets Oct 19, 6:30pm (Asia/Seoul)\nCurrent week (all models): 77% used · resets Oct 24, 3am (Asia/Seoul)\n";
        let v = parse_usage_text(text, now);
        assert_eq!(v["five"]["pct"], 62.0);
        assert_eq!(v["week"]["pct"], 77.0);
        let five = chrono::Local.with_ymd_and_hms(2026, 10, 19, 18, 30, 0).unwrap().timestamp();
        let week = chrono::Local.with_ymd_and_hms(2026, 10, 24, 3, 0, 0).unwrap().timestamp();
        assert_eq!(v["five"]["resetsAt"], five);
        assert_eq!(v["week"]["resetsAt"], week);
        // 날짜 없이 시각만 오면 오늘(지났으면 내일)
        assert_eq!(parse_reset("6:30pm", now), Some(five));
        let tomorrow3 = chrono::Local.with_ymd_and_hms(2026, 10, 20, 3, 0, 0).unwrap().timestamp();
        assert_eq!(parse_reset("3am", now), Some(tomorrow3));
        assert_eq!(parse_reset("12am", now), Some(chrono::Local.with_ymd_and_hms(2026, 10, 20, 0, 0, 0).unwrap().timestamp()));
        // 연말 넘어감
        let dec = chrono::Local.with_ymd_and_hms(2026, 12, 30, 12, 0, 0).unwrap();
        assert_eq!(parse_reset("Jan 2, 1pm", dec), Some(chrono::Local.with_ymd_and_hms(2027, 1, 2, 13, 0, 0).unwrap().timestamp()));
        // 한도 줄이 없으면 비어 있음
        assert!(parse_usage_text("API key", now).get("five").is_none());
    }

    #[test]
    fn same_email_counts_as_one_account() {
        let mut a = acc("a", "claude", true);
        a.email = Some("x@y".into());
        let mut b = acc("b", "claude", true);
        b.email = Some("x@y".into());
        let mut c = acc("c", "claude", true);
        c.email = Some("z@y".into());
        let l = vec![a, b, c];
        assert_eq!(same_account(&l, "a"), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(same_account(&l, "c"), vec!["c".to_string()]);
    }

    #[test]
    fn exhausted_until_and_soonest_reset() {
        let now = 1_000;
        let mut a = acc("a", "codex", true);
        a.exhausted_until = Some(5_000);
        let mut b = acc("b", "codex", true);
        b.exhausted_until = Some(2_000);
        assert!(is_exhausted(&a, now));
        assert_eq!(pick(&[a, b], "codex", now).as_deref(), Some("b"));
    }

    #[test]
    fn keep_at_least_one_enabled() {
        let l = vec![acc("a", "claude", true), acc("b", "claude", false), acc("c", "codex", true)];
        assert!(!can_disable(&l, "a"));
        assert!(!can_disable(&l, "c"));
        let l2 = vec![acc("a", "claude", true), acc("b", "claude", true)];
        assert!(can_disable(&l2, "a"));
    }

    #[test]
    fn codex_limits_by_window_length() {
        let res = json!({ "rateLimits": {
            "primary": { "usedPercent": 2, "windowDurationMins": 10080, "resetsAt": 1792878986 },
            "secondary": { "usedPercent": 40, "windowDurationMins": 300, "resetsAt": 1792399200 },
            "rateLimitReachedType": null
        }});
        let v = parse_codex_limits(&res);
        assert_eq!(v["week"]["pct"], 2.0);
        assert_eq!(v["five"]["pct"], 40.0);
        assert_eq!(v["five"]["resetsAt"], 1792399200);
        assert!(v.get("reached").is_none());
    }

    #[test]
    fn claude_limit_event() {
        let ev = json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed",
            "unifiedWindows": { "five_hour": { "utilization": 0.03, "resetsAt": 10 }, "seven_day": { "utilization": 0.19, "resetsAt": 20 } } } });
        let v = parse_claude_limit_event(&ev).unwrap();
        assert_eq!(v["five"]["pct"], 3.0);
        assert_eq!(v["week"]["pct"], 19.0);
        let rej = json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "rejected", "rateLimitType": "seven_day", "resetsAt": 99, "unifiedWindows": {} } });
        let v = parse_claude_limit_event(&rej).unwrap();
        assert_eq!(v["week"]["pct"], 100.0);
        assert_eq!(v["week"]["resetsAt"], 99);
    }

    /// 실제 CLI로 확인(수동): cargo test --lib real_cli -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_cli() {
        let cx = refresh_codex(&[]);
        println!("codex: {:?}", cx.as_ref().map(|(_, p, l)| (p.clone(), l.clone())));
        assert!(cx.is_ok());
        let st = claude_status(&[]);
        println!("claude status ok: {:?}", st.as_ref().map(|(li, _, p)| (*li, p.clone())));
        assert!(st.is_ok());
        let pr = claude_probe(&[]);
        println!("claude probe: {pr:?}");
        assert!(pr.is_ok());
    }

    #[test]
    fn prepare_home_links_and_copies() {
        let base = std::env::temp_dir().join(format!("aith-acc-test-{}", std::process::id()));
        let src = base.join("src");
        let home = base.join("home");
        std::fs::create_dir_all(src.join("skills")).unwrap();
        std::fs::write(src.join("skills").join("a.md"), "x").unwrap();
        std::fs::write(src.join("config.toml"), "model = \"m\"").unwrap();
        prepare_home(&home, &src, "codex").unwrap();
        // junction을 통해 원본 파일이 보인다 + sessions는 원본에 새로 만들어 연결
        assert!(home.join("skills").join("a.md").exists());
        assert!(src.join("sessions").exists());
        std::fs::write(home.join("sessions").join("s.jsonl"), "{}").unwrap();
        assert!(src.join("sessions").join("s.jsonl").exists());
        assert_eq!(std::fs::read_to_string(home.join("config.toml")).unwrap(), "model = \"m\"");
        // 삭제해도 원본은 남는다
        remove_home(&home, "codex");
        assert!(!home.exists());
        assert!(src.join("skills").join("a.md").exists());
        assert!(src.join("sessions").join("s.jsonl").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fresh_limits_decide_without_old_mark() {
        let now = 1_000;
        let mut a = acc("a", "claude", true);
        // 5시간 한도로 막혔는데 주간 초기화 시각으로 막아 둔 경우 — 새 사용량에 찬 창이 없으면 풀어야 한다
        a.exhausted_until = Some(now + 20_000);
        a.limits = Some(serde_json::json!({ "week": { "pct": 97.0, "resetsAt": now + 20_000 } }));
        assert!(!limits_exhausted(&a, now));
        a.limits = Some(serde_json::json!({ "five": { "pct": 100.0, "resetsAt": now + 100 } }));
        assert!(limits_exhausted(&a, now));
        a.limits = Some(serde_json::json!({ "five": { "pct": 100.0, "resetsAt": now - 1 } }));
        assert!(!limits_exhausted(&a, now));
    }
}
