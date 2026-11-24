// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 릴리스에서 콘솔 창 뜨지 않게
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aitermhub_lib::run()
}
