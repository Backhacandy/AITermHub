// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 백그라운드 모니터: 세션별 메모리 상태를 주기적으로 emit하고, 설정에 따라 유휴 세션을 자동으로 재운다.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::pty::PtyManager;

/// 모니터 스레드 시작(3초 주기).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));

        // 한 바퀴의 트리 조회(탭·에이전트마다 메모리, 자동 재우기의 CPU 시간)는 프로세스 스냅샷 한 장을 함께 쓴다
        crate::procctl::one_snapshot(|| round(&app));
    });
}

fn round(app: &AppHandle) {
    {
        let mgr = app.state::<PtyManager>();

        // 세션 상태(RAM 포함) 전송 — 터미널 탭 + 구조화 세션(Claude·Codex)
        let mut stats = mgr.stats();
        stats.extend(app.state::<crate::claude::ClaudeManager>().stats());
        stats.extend(app.state::<crate::codex::CodexManager>().stats());
        let _ = app.emit("session-stats", &stats);

        // 자동 재우기(설정 on일 때)
        let settings = crate::registry::load(app);
        let auto = settings
            .get("autoSleep")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if auto {
            let mins = settings
                .get("idleMinutes")
                .and_then(|v| v.as_u64())
                .unwrap_or(15)
                .max(1);
            let slept = mgr.auto_sleep_idle(mins * 60 * 1000);
            if !slept.is_empty() {
                let _ = app.emit("auto-slept", serde_json::json!({ "ids": slept }));
            }
        }
    }
}
