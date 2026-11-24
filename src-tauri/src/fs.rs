// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 파일 탐색기용 디렉터리/텍스트 읽기.

use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub path: String,
}

/// 디렉터리 항목 목록(폴더 먼저, 이름순).
pub fn read_dir(path: &str) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full = e.path().to_string_lossy().to_string();
        out.push(Entry { name, dir, path: full });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 텍스트 파일 앞부분(최대 max_bytes) 읽기(미리보기용). 큰 파일도 앞부분만 읽는다.
/// CP949·UTF-16도 디코드하고, 바이너리는 깨진 글자 대신 안내 문구를 돌려준다.
pub fn read_text(path: &str, max_bytes: usize) -> Result<String, String> {
    let r = crate::textread::read(path, max_bytes)?;
    if r.binary {
        return Ok(format!("(바이너리 파일 · {} — 내용을 표시하지 않음)", crate::textread::human_size(r.size)));
    }
    Ok(r.text)
}
