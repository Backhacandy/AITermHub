// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 지시 첨부: 붙여 넣은 이미지(스크린샷)를 프로젝트의 `.aith/attach/`에 저장하고 경로를 돌려준다.
//! 에이전트(Claude Read·Codex 이미지 보기)가 그 경로로 연다. `.aith/`는 git에서 제외한다.

use std::path::{Path, PathBuf};

use base64::Engine;

const MAX_BYTES: usize = 20 * 1024 * 1024;
const EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

pub fn attach_dir(cwd: &Path) -> PathBuf {
    cwd.join(".aith").join("attach")
}

/// 겹치지 않는 파일 이름: shot-YYYYMMDD-HHMMSS[-n].ext
pub fn free_name(dir: &Path, stamp: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("shot-{stamp}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..1000).map(|n| dir.join(format!("shot-{stamp}-{n}.{ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

#[tauri::command]
pub fn attach_save(cwd: String, ext: String, data: String) -> Result<String, String> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    if !EXTS.contains(&ext.as_str()) {
        return Err(format!("지원하지 않는 형식: {ext}"));
    }
    let root = Path::new(&cwd);
    if !root.is_dir() {
        return Err("프로젝트 폴더가 없어요".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| format!("이미지 읽기 실패: {e}"))?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("이미지가 비었거나 20MB를 넘어요".into());
    }
    let dir = attach_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // git 저장소면 .aith/를 커밋 대상에서 뺀다(사용자 .gitignore는 건드리지 않음)
    if root.join(".git").exists() {
        let _ = crate::collab::exclude_aith(root);
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let path = free_name(&dir, &stamp, &ext);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_png_with_unique_names() {
        let tmp = std::env::temp_dir().join(format!("aith-attach-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode([0x89u8, b'P', b'N', b'G']);
        let a = attach_save(tmp.to_string_lossy().into(), "png".into(), data.clone()).unwrap();
        let b = attach_save(tmp.to_string_lossy().into(), "PNG".into(), data).unwrap();
        assert_ne!(a, b);
        assert!(a.contains(".aith") && a.ends_with(".png"));
        assert_eq!(std::fs::read(&a).unwrap(), vec![0x89u8, b'P', b'N', b'G']);
        assert!(attach_save(tmp.to_string_lossy().into(), "exe".into(), "AA==".into()).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
