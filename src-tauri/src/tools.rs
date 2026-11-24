// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 에이전트용 보조 명령(`aith-open`): GUI 프로그램을 허브와 분리해 띄운다.
//! 앱 시작 때 app_data_dir/bin에 스크립트를 쓰고 그 폴더를 PATH 맨 앞에 넣어, 모든 자식(claude·codex·터미널)이 쓸 수 있게 한다.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const PS1: &str = include_str!("../resources/aith-open.ps1");
const CODEX_PS1: &str = include_str!("../resources/aith-codex.ps1");
const HUB_PS1: &str = include_str!("../resources/aith-hub.ps1");
const PROMPT_HOOK: &str = include_str!("../resources/aith-prompt-hook.sh");
/// 훅 등록 여부를 알아보는 표시(명령 경로에 들어 있는 이름)
const HOOK_NAME: &str = "aith-prompt-hook";

/// PowerShell·cmd에서: `aith-open ...`
const CMD: &str = "@powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0aith-open.ps1\" %*\r\n";

/// Git Bash(Claude Code의 Bash 도구)에서: 확장자 없는 sh 스크립트
const SH: &str = "#!/bin/sh\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$(cygpath -w \"$(dirname \"$0\")\")\\\\aith-open.ps1\" \"$@\"\n";

/// 같은 래퍼를 다른 스크립트 이름으로
fn cmd_for(name: &str) -> String {
    CMD.replace("aith-open.ps1", &format!("{name}.ps1"))
}
fn sh_for(name: &str) -> String {
    SH.replace("aith-open.ps1", &format!("{name}.ps1"))
}

/// 에이전트 지시(Claude --append-system-prompt / Codex developer_instructions).
/// cmd.exe를 거쳐 넘어가므로 & | < > ^ % 와 큰따옴표를 쓰지 않는다.
pub const AGENT_HINT: &str = "[허브 안내] GUI 프로그램(Unity, Android Studio, 에뮬레이터, 브라우저 등)이나 계속 떠 있어야 하는 프로그램을 실행할 때는 반드시 aith-open 명령을 써라. 예: aith-open 'C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe' 'C:\\내프로젝트' 또는 aith-open 'C:\\내프로젝트\\Assets\\Scenes\\Main.unity'. Start-Process, start, 뒤에 붙이는 실행 등 일반 방식으로 띄우면 작업이 끝날 때 함께 꺼진다. 파일·폴더·주소를 기본 프로그램으로 열 때도 aith-open 경로를 쓴다. 사용자 화면을 빼앗지 마라: 테스트하면서 창을 맨 앞으로 올리거나(SetForegroundWindow, BringWindowToTop, AttachThreadInput, 최소화 뒤 복원) 운영체제에 진짜 키·마우스 입력(SendInput, keybd_event, mouse_event)을 보내거나 화면 영역을 캡처하지 마라 — 사용자가 다른 일을 못 한다. 게임(Unity)을 실제로 플레이하며 확인할 때는 테스트 빌드에 Run In Background를 켜 뒤에 둔 채 실행하고, 입력은 엔진 안에서 넣고(Unity Input System의 InputTestFixture, QueueStateEvent 등), 화면은 게임 안에서 찍어(ScreenCapture 또는 카메라 RenderTexture) 그 PNG를 열어 보며 진행한다. 게임 창을 최소화하면 화면이 그려지지 않으니 최소화하지 마라. 화면이 필요 없는 자동 테스트는 Unity -batchmode -runTests로 돌린다. 진짜 운영체제 입력이 꼭 필요한 테스트는 먼저 사용자에게 물어 허락을 받은 뒤에만 한다.";

/// 비싼 모델이 맡길 싼 서브에이전트(Claude --agents 파일). 비싼 모델은 결정·고치기만 하고,
/// 여러 파일을 뒤지는 탐색과 출력이 긴 실행 결과 읽기는 따로 된 대화에서 싼 모델이 하고 요약만 돌려준다.
pub const AGENTS_FILE: &str = "aith-agents.json";
fn agents_json() -> serde_json::Value {
    serde_json::json!({
        "aith-scout": {
            "description": "여러 파일을 뒤져 어디에 무엇이 있는지 찾아야 할 때(낯선 코드, 기능이 있는 곳, 호출 관계) 먼저 맡긴다. 관련 파일·줄·따라야 할 패턴 지도만 돌려준다. 읽기 전용.",
            "prompt": "너는 코드 정찰 담당이다. 맡은 일에 필요한 파일·함수·위치를 찾아 지도로 돌려준다. 파일을 고치거나 만들지 마라(셸도 읽기만). 돌려줄 것: 1) 관련 파일 경로:줄 범위와 각각 무엇을 하는지 한 줄, 2) 고칠 때 따라야 할 기존 패턴과 비슷한 예, 3) 함께 바뀌어야 할 곳(부르는 곳, 테스트, 설정), 4) 확실하지 않은 것은 확실하지 않다고. 코드는 꼭 필요한 부분만 10줄 안으로 인용하고 파일 전체를 옮기지 마라. 짧고 정확하게.",
            "tools": ["Read", "Grep", "Glob", "Bash", "PowerShell"],
            "model": "sonnet"
        },
        "aith-runner": {
            "description": "출력이 긴 빌드·테스트·린트·로그 확인을 맡긴다. 통과/실패와 실패한 곳의 원문만 돌려준다. 고치지 않는다.",
            "prompt": "너는 실행 담당이다. 받은 빌드·테스트·린트·스크립트 명령을 실행하거나 로그를 읽고 결과만 돌려준다. 파일을 고치지 말고 실패를 고치려 하지 마라. 통과면 통과와 핵심 숫자(테스트 개수 등) 한 줄. 실패면 실패한 항목마다 파일:줄과 오류 메시지를 원문 그대로(줄이거나 바꿔 말하지 마라) 적고 관련 스택 몇 줄을 붙인다. 같은 오류가 되풀이되면 한 번만 적고 몇 번인지 적는다. 오래 걸리는 명령은 끝날 때까지 기다린다. GUI 프로그램을 띄우는 명령은 실행하지 말고 그렇다고 알린다.",
            "tools": ["Bash", "PowerShell", "Read", "Grep", "Glob"],
            "model": "haiku"
        }
    })
}

/// 위 서브에이전트를 언제 쓰는지(Claude에만 붙인다 — Codex에는 이 서브에이전트가 없다).
/// AGENT_HINT와 같은 이유로 & | < > ^ % 와 큰따옴표를 쓰지 않는다.
pub const DELEGATE_HINT: &str = "[토큰 아끼기] 여러 파일을 뒤져야 하는 탐색은 aith-scout 서브에이전트에게, 출력이 긴 빌드·테스트·로그 확인은 aith-runner 서브에이전트에게 맡기고 요약만 받아라. 직접 고칠 파일은 직접 읽고, 파일 한두 개 읽기나 출력이 짧은 명령은 직접 해라(서브에이전트를 띄우는 데도 비용이 든다). 요약만으로 실패 원인이 불분명하면 그 부분만 직접 다시 확인해라. 일반 서브에이전트(general-purpose 등)를 띄울 때는 일에 맞게 model을 haiku나 sonnet으로 정해라 — 정하지 않으면 지금의 비싼 모델을 그대로 쓴다.";

/// Claude에 붙일 --agents 파일 경로(앱 시작 때 install이 써 둔 것)
pub fn agents_file(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path().app_data_dir().ok()?.join("bin").join(AGENTS_FILE);
    p.exists().then_some(p)
}

fn write_if_changed(p: &Path, data: &[u8]) {
    if std::fs::read(p).map(|cur| cur == data).unwrap_or(false) {
        return;
    }
    let _ = std::fs::write(p, data);
}

/// 스크립트를 쓰고(내용이 같으면 건너뜀) bin 폴더 경로를 돌려준다.
pub fn install(app: &AppHandle) -> Option<PathBuf> {
    let bin = app.path().app_data_dir().ok()?.join("bin");
    std::fs::create_dir_all(&bin).ok()?;
    // Windows PowerShell 5.1은 BOM 없는 UTF-8을 ANSI로 읽어 한글이 깨진다 → BOM
    for (name, body) in [("aith-open", PS1), ("aith-codex", CODEX_PS1), ("aith-hub", HUB_PS1)] {
        let mut ps1 = vec![0xEF, 0xBB, 0xBF];
        ps1.extend_from_slice(body.as_bytes());
        write_if_changed(&bin.join(format!("{name}.ps1")), &ps1);
        write_if_changed(&bin.join(format!("{name}.cmd")), cmd_for(name).as_bytes());
        write_if_changed(&bin.join(name), sh_for(name).as_bytes());
    }
    write_if_changed(&bin.join(AGENTS_FILE), serde_json::to_string_pretty(&agents_json()).unwrap_or_default().as_bytes());
    // sh 스크립트는 LF여야 한다(git이 CRLF로 바꿔 받았을 수 있음)
    write_if_changed(&bin.join(HOOK_NAME), PROMPT_HOOK.replace("\r\n", "\n").as_bytes());
    Some(bin)
}

/// Claude 설정(settings.json)에 원격 세션용 프롬프트 훅을 등록한다(이미 있으면 경로만 맞춤).
/// 훅은 AITH_REMOTE=1인 세션(허브가 띄운 원격 제어)에서만 동작하고, 그 외에는 아무것도 출력하지 않는다.
pub fn ensure_prompt_hook(settings: &Path, bin: &Path) -> Result<(), String> {
    let script = bin.join(HOOK_NAME).to_string_lossy().replace('\\', "/");
    let command = format!("sh \"{script}\"");
    let mut root: serde_json::Value = match std::fs::read_to_string(settings) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).map_err(|e| format!("{} 읽기 실패: {e}", settings.display()))?,
        _ => serde_json::json!({}),
    };
    if !set_hook(&mut root, &command) {
        return Ok(());
    }
    if let Some(dir) = settings.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(settings, text + "\n").map_err(|e| e.to_string())
}

/// hooks.UserPromptSubmit에 우리 훅을 넣거나 경로를 고친다. 바뀌었으면 true
fn set_hook(root: &mut serde_json::Value, command: &str) -> bool {
    use serde_json::{json, Value};
    if !root.is_object() {
        *root = json!({});
    }
    let hooks = root.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let list = hooks.as_object_mut().unwrap().entry("UserPromptSubmit").or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    for group in list.as_array_mut().unwrap() {
        for h in group.get_mut("hooks").and_then(Value::as_array_mut).into_iter().flatten() {
            let cur = h.get("command").and_then(Value::as_str).unwrap_or("");
            if cur.contains(HOOK_NAME) {
                if cur == command {
                    return false;
                }
                h["command"] = json!(command);
                return true;
            }
        }
    }
    list.as_array_mut().unwrap().push(json!({ "hooks": [{ "type": "command", "command": command }] }));
    true
}

/// 이 프로세스의 PATH 맨 앞에 bin을 넣는다(이후 띄우는 모든 자식이 상속).
pub fn add_to_path(bin: &Path) {
    let cur = std::env::var("PATH").unwrap_or_default();
    let b = bin.to_string_lossy();
    if cur.split(';').any(|p| p.eq_ignore_ascii_case(&b)) {
        return;
    }
    std::env::set_var("PATH", format!("{b};{cur}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_is_added_once_and_keeps_other_settings() {
        let mut v = serde_json::json!({ "model": "opus", "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "other" }] }] } });
        assert!(set_hook(&mut v, "sh \"C:/a/aith-prompt-hook\""));
        assert!(!set_hook(&mut v, "sh \"C:/a/aith-prompt-hook\""));
        assert_eq!(v["hooks"]["UserPromptSubmit"].as_array().unwrap().len(), 2);
        assert_eq!(v["model"], "opus");
        // 설치 경로가 바뀌면 고친다(새로 추가하지 않음)
        assert!(set_hook(&mut v, "sh \"D:/b/aith-prompt-hook\""));
        assert_eq!(v["hooks"]["UserPromptSubmit"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["UserPromptSubmit"][1]["hooks"][0]["command"], "sh \"D:/b/aith-prompt-hook\"");
        let mut empty = serde_json::json!({});
        assert!(set_hook(&mut empty, "x/aith-prompt-hook"));
    }

    #[test]
    fn cheap_subagents_for_reading_and_running() {
        let v = agents_json();
        assert_eq!(v["aith-scout"]["model"], "sonnet");
        assert_eq!(v["aith-runner"]["model"], "haiku");
        // 둘 다 고치는 도구는 없다
        for a in ["aith-scout", "aith-runner"] {
            let tools: Vec<&str> = v[a]["tools"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
            assert!(!tools.iter().any(|t| ["Edit", "Write", "NotebookEdit"].contains(t)), "{a}");
        }
        for w in ["aith-scout", "aith-runner", "model"] {
            assert!(DELEGATE_HINT.contains(w), "{w}");
        }
        for c in ['&', '|', '<', '>', '^', '%', '"'] {
            assert!(!DELEGATE_HINT.contains(c), "{c}");
        }
    }

    #[test]
    fn wrappers_point_to_their_script() {
        assert!(cmd_for("aith-codex").contains("aith-codex.ps1"));
        assert!(sh_for("aith-codex").contains("aith-codex.ps1"));
    }

    #[test]
    fn hint_forbids_stealing_the_screen() {
        // 테스트하며 창을 맨 앞으로 올리고 진짜 키 입력을 보내 사용자가 다른 일을 못 하게 되는 일을 막는다
        for w in ["SetForegroundWindow", "SendInput", "-batchmode", "물어"] {
            assert!(AGENT_HINT.contains(w), "{w}");
        }
    }

    #[test]
    fn hint_has_no_cmd_special_chars() {
        for c in ['&', '|', '<', '>', '^', '%', '"'] {
            assert!(!AGENT_HINT.contains(c), "{c}");
        }
        // Codex에는 TOML 여러 줄 리터럴('''…''')로 넘기므로 작은따옴표 세 개가 연달아 오면 안 된다
        assert!(!AGENT_HINT.contains("'''"));
    }
}
