// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 추천 패널: 현재 프로젝트 폴더를 훑어 신호를 모으고, 설치할 수 있는 플러그인 목록(로컬 마켓 사본)과
//! 설치·켜짐 상태, 설치된 스킬, 토큰 관련 사실을 반환한다. 어떤 걸 추천할지는 프론트에서 정한다.
//! 모두 로컬 파일만 읽는다(네트워크·토큰 0).

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Default)]
pub struct Scan {
    /// 프로젝트 유형 신호: "rust","unity","svelte","typescript" …
    pub signals: Vec<String>,
    /// CLAUDE.md 바이트(없으면 0)
    pub claude_md_bytes: u64,
    pub has_git: bool,
    /// 이 cwd의 Claude 대화기록(jsonl) 총 바이트 — "이어서" 시 재업로드되는 대략의 양
    pub transcript_bytes: u64,
    /// 설치할 수 있는 플러그인 전체(등록된 마켓의 로컬 사본)
    pub catalog: Vec<CatalogItem>,
    /// 설치된 플러그인 id("이름@마켓")
    pub installed: Vec<String>,
    /// 켜 둔 플러그인 id
    pub enabled: Vec<String>,
    /// 설치된 스킬(설치된 플러그인 + 내 스킬 폴더)
    pub skills: Vec<SkillInfo>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct CatalogItem {
    pub name: String,
    pub market: String,
    pub description: String,
    pub category: Option<String>,
    /// 설치 수(마켓 통계 — 없으면 None)
    pub installs: Option<u64>,
    /// 켜 두면 매 세션 컨텍스트에 늘 올라가는 토큰(Sonnet 기준 추정)
    pub always_on: Option<u64>,
    /// 들어 있는 스킬 이름
    pub skills: Vec<String>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// 들어 있는 플러그인(내 스킬 폴더면 None)
    pub plugin: Option<String>,
}

// ---------- 프로젝트 신호 ----------

fn read_small(p: &Path) -> String {
    std::fs::read_to_string(p).map(|s| s.chars().take(200_000).collect()).unwrap_or_default()
}

/// 최상위(+ 한 단계 아래 폴더 이름)만 훑는다 — 대형 프로젝트(Unity 등)에서도 빠르게.
fn scan_signals(cwd: &str) -> (Vec<String>, u64, bool) {
    let root = Path::new(cwd);
    let mut names: Vec<String> = Vec::new();
    let mut claude_md_bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if n == "claude.md" {
                claude_md_bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
            }
            // 한 단계 아래 파일 이름도(모노레포·src-tauri 등)
            if e.path().is_dir() && !n.starts_with('.') && !matches!(n.as_str(), "node_modules" | "target" | "library" | "temp" | "build" | "dist") {
                if let Ok(sub) = std::fs::read_dir(e.path()) {
                    for s in sub.flatten().take(400) {
                        names.push(format!("{n}/{}", s.file_name().to_string_lossy().to_lowercase()));
                    }
                }
            }
            names.push(n);
        }
    }
    let has_git = names.iter().any(|n| n == ".git");
    let pkg = read_small(&root.join("package.json")).to_lowercase();
    let cargo = format!("{}\n{}", read_small(&root.join("Cargo.toml")), read_small(&root.join("src-tauri").join("Cargo.toml"))).to_lowercase();
    let git_config = read_small(&root.join(".git").join("config")).to_lowercase();
    (signals_from(&names, &pkg, &cargo, &git_config), claude_md_bytes, has_git)
}

/// 파일 이름 목록(최상위 + "폴더/이름")과 package.json·Cargo.toml·git 설정 글 → 신호(순수 규칙)
pub fn signals_from(names: &[String], pkg: &str, cargo: &str, git_config: &str) -> Vec<String> {
    let has = |n: &str| names.iter().any(|x| x == n);
    let ends = |suf: &str| names.iter().any(|x| x.ends_with(suf));
    let dep = |d: &str| pkg.contains(&format!("\"{d}\""));
    let dep_pre = |d: &str| pkg.contains(&format!("\"{d}"));
    let mut s: Vec<&str> = Vec::new();
    let mut add = |on: bool, x: &'static str| {
        if on {
            s.push(x);
        }
    };
    let node = has("package.json");
    add(!cargo.trim().is_empty() || ends("/cargo.toml"), "rust");
    add(has("src-tauri") || cargo.contains("tauri"), "tauri");
    add(node, "node");
    add(has("tsconfig.json") || dep("typescript"), "typescript");
    add(dep("svelte") || dep("@sveltejs/kit"), "svelte");
    add(dep("react"), "react");
    add(dep("vue") || dep("nuxt"), "vue");
    add(dep("next"), "next");
    add(dep_pre("@angular/"), "angular");
    add(dep("prisma") || dep("@prisma/client"), "prisma");
    add(dep_pre("@supabase/"), "supabase");
    add(dep("firebase") || dep("firebase-admin") || has("firebase.json"), "firebase");
    add(dep("stripe") || dep_pre("@stripe/"), "stripe");
    add(dep_pre("@playwright/") || dep("playwright"), "playwright");
    add(dep("expo"), "expo");
    add(dep_pre("@sentry/"), "sentry");
    add(dep("mongodb") || dep("mongoose"), "mongodb");
    add(dep("redis") || dep("ioredis"), "redis");
    add(has("requirements.txt") || has("pyproject.toml") || has("setup.py") || has("pipfile") || names.iter().any(|x| !x.contains('/') && x.ends_with(".py")), "python");
    add(has("go.mod"), "go");
    add(has("pom.xml"), "java");
    add(has("build.gradle.kts") || ends(".kt") || ends("/build.gradle.kts"), "kotlin");
    add(ends("androidmanifest.xml") || has("app/build.gradle") || has("app/build.gradle.kts"), "android");
    add(has("package.swift") || ends(".xcodeproj"), "swift");
    let unity = has("assets") && has("projectsettings");
    add(unity, "unity");
    add(unity || ends(".csproj") || ends(".sln"), "csharp");
    add(ends(".uproject"), "unreal");
    add(has("cmakelists.txt") || ends(".vcxproj"), "cpp");
    add(has("composer.json"), "php");
    add(has("artisan"), "laravel");
    add(has("gemfile"), "ruby");
    add(has(".luarc.json") || names.iter().any(|x| !x.contains('/') && x.ends_with(".lua")), "lua");
    add(ends(".tf"), "terraform");
    add(has("dockerfile") || has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yml"), "docker");
    add(names.iter().any(|x| !x.contains('/') && x.ends_with(".sql")), "sql");
    add(has(".github") || git_config.contains("github.com"), "github");
    add(has("vercel.json"), "vercel");
    add(has("netlify.toml"), "netlify");
    add(has("wrangler.toml") || has("wrangler.jsonc"), "cloudflare");
    s.into_iter().map(String::from).collect()
}

/// projects/<인코딩된 cwd>의 jsonl 총 바이트 합.
fn transcript_bytes(cwd: &str) -> u64 {
    let dir = crate::util::claude_project_dir(cwd);
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.path().extension().map(|x| x == "jsonl").unwrap_or(false) {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

// ---------- 플러그인 목록·설치 상태 ----------

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// 등록된 마켓들(plugins/marketplaces/*/.claude-plugin/marketplace.json) + 마켓 통계(plugin-catalog-cache.json)
pub fn catalog(claude_home: &Path) -> Vec<CatalogItem> {
    let plugins = claude_home.join("plugins");
    let stats = read_json(&plugins.join("plugin-catalog-cache.json"));
    let stat = &stats["catalog"]["plugins"];
    let mut out = Vec::new();
    let Ok(markets) = std::fs::read_dir(plugins.join("marketplaces")) else { return out };
    for m in markets.flatten() {
        let mj = read_json(&m.path().join(".claude-plugin").join("marketplace.json"));
        let market = mj["name"].as_str().map(String::from).unwrap_or_else(|| m.file_name().to_string_lossy().into_owned());
        for p in mj["plugins"].as_array().into_iter().flatten() {
            let Some(name) = p["name"].as_str() else { continue };
            let st = &stat[format!("{name}@{market}")];
            // 모델별 토큰 중 Sonnet 값(없으면 아무거나)
            let toks = st["tokens"].as_object();
            let always_on = toks.and_then(|t| t.iter().find(|(k, _)| k.contains("sonnet")).or_else(|| t.iter().next())).and_then(|(_, v)| v["always_on"].as_u64());
            out.push(CatalogItem {
                name: name.to_string(),
                market: market.clone(),
                description: p["description"].as_str().unwrap_or("").chars().take(400).collect(),
                category: p["category"].as_str().map(String::from),
                installs: st["unique_installs"].as_u64(),
                always_on,
                skills: st["components"]["skills"].as_array().into_iter().flatten().filter_map(|s| s["name"].as_str().map(String::from)).collect(),
            });
        }
    }
    out
}

/// 설치된 플러그인 id와 설치 경로들(installed_plugins.json)
fn installed(claude_home: &Path) -> Vec<(String, Vec<String>)> {
    let j = read_json(&claude_home.join("plugins").join("installed_plugins.json"));
    let Some(map) = j["plugins"].as_object() else { return vec![] };
    map.iter()
        .map(|(id, v)| {
            let paths = v.as_array().into_iter().flatten().filter_map(|x| x["installPath"].as_str().map(String::from)).collect();
            (id.clone(), paths)
        })
        .collect()
}

/// settings.json enabledPlugins 중 켜진 것
fn enabled(claude_home: &Path) -> Vec<String> {
    let j = read_json(&claude_home.join("settings.json"));
    j["enabledPlugins"].as_object().map(|m| m.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect()).unwrap_or_default()
}

/// SKILL.md 앞머리의 description
pub fn skill_description(text: &str) -> String {
    let mut in_front = false;
    for (i, line) in text.lines().enumerate() {
        let l = line.trim();
        if i == 0 && l == "---" {
            in_front = true;
            continue;
        }
        if in_front && l == "---" {
            break;
        }
        if let Some(d) = l.strip_prefix("description:") {
            return d.trim().trim_matches('"').chars().take(300).collect();
        }
    }
    String::new()
}

fn skills_in(dir: &Path, plugin: Option<&str>, out: &mut Vec<SkillInfo>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for s in rd.flatten() {
        let md = s.path().join("SKILL.md");
        if !md.exists() {
            continue;
        }
        let name = s.file_name().to_string_lossy().into_owned();
        if out.iter().any(|x| x.name == name) {
            continue;
        }
        let head: String = read_small(&md).chars().take(3000).collect();
        out.push(SkillInfo { name, description: skill_description(&head), plugin: plugin.map(String::from) });
    }
}

/// 추천 패널용 스캔 수행.
pub fn scan(cwd: &str) -> Scan {
    let home = Path::new(&std::env::var("USERPROFILE").unwrap_or_default()).join(".claude");
    let (signals, claude_md_bytes, has_git) = scan_signals(cwd);
    let inst = installed(&home);
    let mut skills = Vec::new();
    for (id, paths) in &inst {
        // 같은 플러그인이 여러 버전이면 마지막(보통 최신) 경로만
        if let Some(p) = paths.iter().rev().find(|p| Path::new(p).exists()) {
            skills_in(&Path::new(p).join("skills"), Some(id.split('@').next().unwrap_or(id)), &mut skills);
        }
    }
    skills_in(&home.join("skills"), None, &mut skills);
    Scan {
        signals,
        claude_md_bytes,
        has_git,
        transcript_bytes: transcript_bytes(cwd),
        catalog: catalog(&home),
        installed: inst.into_iter().map(|(id, _)| id).collect(),
        enabled: enabled(&home),
        skills,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_project_kinds() {
        let unity = signals_from(&n(&["assets", "projectsettings", "packages", "mygame.sln"]), "", "", "");
        assert!(unity.contains(&"unity".into()) && unity.contains(&"csharp".into()));
        let tauri = signals_from(&n(&["package.json", "src-tauri", "src-tauri/cargo.toml", "tsconfig.json", ".git"]), r#"{"devDependencies":{"svelte":"5","@sveltejs/kit":"2"}}"#, "[dependencies]\ntauri = \"2\"", "url = https://github.com/a/b");
        for s in ["rust", "tauri", "node", "typescript", "svelte", "github"] {
            assert!(tauri.contains(&s.to_string()), "{s}");
        }
        assert!(!tauri.contains(&"react".into()));
        assert!(signals_from(&n(&["main.py"]), "", "", "").contains(&"python".into()));
        // 하위 폴더의 .py는 python 신호로 치지 않는다(도구 스크립트 하나로 오인하지 않게)
        assert!(!signals_from(&n(&["tools/x.py"]), "", "", "").contains(&"python".into()));
    }

    #[test]
    fn reads_skill_description() {
        let t = "---\nname: unity-cli\ndescription: Use when interacting with Unity CLI\n---\n# body\ndescription: no";
        assert_eq!(skill_description(t), "Use when interacting with Unity CLI");
        assert_eq!(skill_description("# no front matter"), "");
    }

    #[test]
    fn catalog_merges_market_and_stats() {
        let base = std::env::temp_dir().join(format!("aith-reco-{}", std::process::id()));
        let mk = base.join("plugins").join("marketplaces").join("off").join(".claude-plugin");
        std::fs::create_dir_all(&mk).unwrap();
        std::fs::write(mk.join("marketplace.json"), r#"{"name":"official","plugins":[{"name":"unity","description":"Unity skills","category":"development"}]}"#).unwrap();
        std::fs::write(
            base.join("plugins").join("plugin-catalog-cache.json"),
            r#"{"catalog":{"plugins":{"unity@official":{"unique_installs":206,"tokens":{"claude-opus-4-7":{"always_on":5393},"claude-sonnet-4-6":{"always_on":3546}},"components":{"skills":[{"name":"unity-cli"}]}}}}}"#,
        )
        .unwrap();
        let c = catalog(&base);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(
            c,
            vec![CatalogItem {
                name: "unity".into(),
                market: "official".into(),
                description: "Unity skills".into(),
                category: Some("development".into()),
                installs: Some(206),
                always_on: Some(3546),
                skills: vec!["unity-cli".into()],
            }]
        );
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn live_scan() {
        for d in ["C:/AITermHub", "C:/MyGame"] {
            let s = super::scan(d);
            println!("{d}: signals={:?} catalog={} installed={:?} enabled={:?} skills={}", s.signals, s.catalog.len(), s.installed, s.enabled, s.skills.len());
            println!("  skills: {:?}", s.skills.iter().take(8).map(|x| (&x.name, x.plugin.clone())).collect::<Vec<_>>());
        }
    }
}
