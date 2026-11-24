// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Codex에게 붙이는 공통 규칙.

/** 한 패치에 같은 파일을 두 번 넣어 거부당하는("apply_patch verification failed: multiple operations target …") 실수를 줄인다 */
export const CODEX_PATCH_RULE = "apply_patch 하나에서 같은 파일은 한 번만 다뤄라. 한 파일의 여러 곳을 고칠 때는 그 파일 블록 하나 안에 묶어라.";
