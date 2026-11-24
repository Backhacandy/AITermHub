// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 웹 미리보기: 이 PC에서 떠 있는 개발 서버 포트를 찾고, package.json으로 실행 스크립트와 포트를 짐작한다.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// 흔한 개발 서버 포트(vite·next·angular·astro·expo·일반)
const PORTS: [u16; 12] = [5173, 5174, 3000, 3001, 4200, 4321, 8080, 8000, 5000, 8081, 19006, 4173];

fn open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok()
}

/// 실행 스크립트 문자열 → 예상 포트
pub fn guess_port(script: &str) -> Option<u16> {
    let s = script.to_lowercase();
    // --port 1234 / --port=1234 / -p 1234
    let toks: Vec<&str> = s.split(|c: char| c.is_whitespace() || c == '=').filter(|t| !t.is_empty()).collect();
    for w in toks.windows(2) {
        if (w[0] == "--port" || w[0] == "-p") && w[1].parse::<u16>().is_ok() {
            return w[1].parse().ok();
        }
    }
    if s.contains("vite") {
        return Some(5173);
    }
    if s.contains("next") || s.contains("react-scripts") || s.contains("nuxt") || s.contains("remix") {
        return Some(3000);
    }
    if s.contains("ng serve") || s.contains("ng ") && s.contains("serve") {
        return Some(4200);
    }
    if s.contains("astro") {
        return Some(4321);
    }
    if s.contains("expo") {
        return Some(8081);
    }
    None
}

/// package.json의 scripts에서 dev → start → serve 순으로 고른다: (이름, 내용)
pub fn pick_script(pkg: &Value) -> Option<(String, String)> {
    let scripts = pkg.get("scripts")?.as_object()?;
    ["dev", "start", "serve"].iter().find_map(|k| scripts.get(*k).and_then(|v| v.as_str()).map(|v| (k.to_string(), v.to_string())))
}

/// {open: [열린 포트], script: "dev"|null, guess: 포트|null}
#[tauri::command(async)]
pub fn preview_probe(cwd: String) -> Value {
    let open_ports: Vec<u16> = PORTS.iter().copied().filter(|p| open(*p)).collect();
    let pkg = std::fs::read_to_string(Path::new(&cwd).join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let (script, guess) = match pkg.as_ref().and_then(pick_script) {
        Some((name, body)) => (Some(name), guess_port(&body)),
        None => (None, None),
    };
    json!({ "open": open_ports, "script": script, "guess": guess })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_ports_from_scripts() {
        assert_eq!(guess_port("vite"), Some(5173));
        assert_eq!(guess_port("vite --port 4000"), Some(4000));
        assert_eq!(guess_port("next dev -p 3005"), Some(3005));
        assert_eq!(guess_port("ng serve"), Some(4200));
        assert_eq!(guess_port("node server.js"), None);
    }

    #[test]
    fn picks_dev_script_first() {
        let pkg = serde_json::json!({ "scripts": { "start": "node a", "dev": "vite" } });
        assert_eq!(pick_script(&pkg), Some(("dev".into(), "vite".into())));
        assert_eq!(pick_script(&serde_json::json!({})), None);
    }
}
