// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
//! 파일을 "보여줄 수 있는 텍스트"로 읽기: 바이너리 판별 + 인코딩 판별(UTF-8/BOM/UTF-16/CP949).
//! Windows의 PowerShell(Codex가 파일을 쓰는 방식)은 CP949·UTF-16으로 저장하는 경우가 많고,
//! 작업 폴더에는 이미지·압축 파일 같은 바이너리도 섞여 있어 UTF-8로만 읽으면 화면이 깨진다.

use std::io::Read;

use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct TextRead {
    /// 바이너리면 빈 문자열
    pub text: String,
    /// "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "cp949" | "binary"
    pub encoding: &'static str,
    pub binary: bool,
    /// 파일 전체 크기(바이트)
    pub size: u64,
}

/// 확장자만으로 확실한 바이너리.
const BINARY_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tif", "tiff", "psd",
    "zip", "gz", "tgz", "7z", "rar", "xz", "bz2", "zst", "jar", "war",
    "exe", "dll", "so", "dylib", "lib", "a", "o", "obj", "pdb", "bin", "wasm", "class", "pyc",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "wav", "ogg", "mov", "avi", "mkv", "webm", "flac",
    "db", "sqlite", "sqlite3", "db-wal", "db-shm",
];

fn ext_is_binary(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            BINARY_EXT.contains(&e.as_str())
        })
        .unwrap_or(false)
}

/// 텍스트에서 보기 드문 제어 문자 비율이 높으면 바이너리로 본다.
fn looks_binary(s: &str) -> bool {
    let mut total = 0usize;
    let mut bad = 0usize;
    for c in s.chars().take(8000) {
        total += 1;
        if c == '\u{FFFD}' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{0C}')) {
            bad += 1;
        }
    }
    total > 0 && bad * 100 / total >= 5
}

fn utf16(bytes: &[u8], le: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// 바이트를 표시용 텍스트로. `truncated`면 끝에서 잘린 멀티바이트 문자를 허용한다.
pub fn decode(bytes: &[u8], truncated: bool) -> (String, &'static str, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), "utf-8-bom", false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return (utf16(rest, true), "utf-16le", false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return (utf16(rest, false), "utf-16be", false);
    }
    let head = &bytes[..bytes.len().min(8000)];
    if head.contains(&0) {
        return (String::new(), "binary", true);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => {
            let binary = looks_binary(s);
            (if binary { String::new() } else { s.to_string() }, if binary { "binary" } else { "utf-8" }, binary)
        }
        // 최대 크기로 잘라 읽어 끝 글자가 반쯤 잘린 경우는 UTF-8로 본다
        Err(e) if truncated && e.error_len().is_none() => {
            let s = std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or_default();
            (s.to_string(), "utf-8", false)
        }
        Err(_) => {
            let (cow, _, had_errors) = encoding_rs::EUC_KR.decode(bytes);
            if !had_errors && !looks_binary(&cow) {
                (cow.into_owned(), "cp949", false)
            } else {
                (String::new(), "binary", true)
            }
        }
    }
}

/// 파일 앞부분(최대 max_bytes)을 읽어 판별·디코드.
pub fn read(path: &str, max_bytes: usize) -> Result<TextRead, String> {
    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if ext_is_binary(path) {
        return Ok(TextRead { text: String::new(), encoding: "binary", binary: true, size });
    }
    let mut data = Vec::new();
    f.take(max_bytes as u64).read_to_end(&mut data).map_err(|e| e.to_string())?;
    let (text, encoding, binary) = decode(&data, (data.len() as u64) < size);
    Ok(TextRead { text, encoding, binary, size })
}

/// 사람이 읽을 크기 표기.
pub fn human_size(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    } else if n >= 1024 {
        format!("{} KB", n / 1024)
    } else {
        format!("{n} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_text() {
        assert_eq!(decode("안녕\nhi".as_bytes(), false), ("안녕\nhi".to_string(), "utf-8", false));
    }

    #[test]
    fn boms() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("가".as_bytes());
        assert_eq!(decode(&b, false).0, "가");
        assert_eq!(decode(&b, false).1, "utf-8-bom");
        // UTF-16LE "가A" = FF FE 00 AC 41 00
        let (t, enc, bin) = decode(&[0xFF, 0xFE, 0x00, 0xAC, 0x41, 0x00], false);
        assert_eq!((t.as_str(), enc, bin), ("가A", "utf-16le", false));
    }

    #[test]
    fn cp949_korean() {
        // "한글" in CP949 = C7 D1 B1 DB
        let (t, enc, bin) = decode(&[0xC7, 0xD1, 0xB1, 0xDB, b'\n'], false);
        assert_eq!((t.as_str(), enc, bin), ("한글\n", "cp949", false));
    }

    #[test]
    fn binary_detected() {
        assert!(decode(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00], false).2);
        // NUL 없는 압축 데이터 같은 무작위 바이트
        let noise: Vec<u8> = (0..4000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8 | 0x80).collect();
        assert!(decode(&noise, false).2);
    }

    #[test]
    fn truncated_utf8_tail_is_ok() {
        let b = "가나".as_bytes();
        let (t, enc, bin) = decode(&b[..4], true); // "가" + 잘린 1바이트
        assert_eq!((t.as_str(), enc, bin), ("가", "utf-8", false));
    }

    #[test]
    fn binary_extension_short_circuits() {
        assert!(ext_is_binary(r"C:\p\shot.PNG"));
        assert!(!ext_is_binary(r"C:\p\a.ts"));
    }
}
