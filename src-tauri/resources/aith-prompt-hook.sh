#!/bin/sh
# Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
# Claude Code UserPromptSubmit 훅: 허브가 띄운 원격 제어(폰·claude.ai) 세션에서만 동작한다(AITH_REMOTE=1).
# 메시지 맨 앞 호출어에 따라 Claude가 직접 하지 않고 허브 명령으로 넘기라는 안내를 붙인다.
#   @co·@codex·@코·@코덱스  → aith-codex(Codex에게만)
#   @상태·@status            → aith-hub status(허브 상태)
#   @pair·@협업·@페어        → aith-hub pair(협업 탭: Claude+Codex)
# 그 외 메시지·다른 세션에는 아무것도 하지 않는다(출력 없음 = 토큰 0).
[ "$AITH_REMOTE" = "1" ] || exit 0
input=$(cat)
has() { printf '%s' "$input" | LC_ALL=C grep -qE "\"prompt\" *: *\"[[:space:]]*@($1)([[:space:],.:!?\"]|\\\\|\$)"; }

if has 'co|cod|code|codex|코|코덱스'; then
cat <<'MSG'
[AITermHub 원격] 이 메시지는 맨 앞 호출어(@co 등)로 Codex에게만 보낸 지시입니다. 직접 작업하거나 파일을 살펴보지 마세요.
호출어를 뺀 지시 내용을 고치지 말고 그대로 Bash 도구로 Codex에 넘기세요(run_in_background: true로 실행):
aith-codex <<'AITH_EOF'
(지시 내용 그대로)
AITH_EOF
끝났다는 알림이 오면 출력 파일을 읽어 [Codex 답변] 아래 내용을 요약하거나 고치지 말고 그대로 보여주세요. 덧붙일 말은 한 줄 이내로.
MSG
elif has '상태|status'; then
cat <<'MSG'
[AITermHub 원격] 사용자가 PC 허브 상태를 물었습니다. 다른 작업 없이 Bash 도구로 aith-hub status 를 실행하고, 출력을 고치지 말고 그대로 보여주세요.
MSG
elif has 'pair|협업|페어'; then
cat <<'MSG'
[AITermHub 원격] 이 메시지는 PC 허브의 팀 탭(여러 에이전트가 나눠 맡음)에 보낸 지시입니다. 직접 작업하거나 파일을 살펴보지 마세요.
호출어를 뺀 지시 내용을 고치지 말고 그대로 Bash 도구로 넘기세요(run_in_background: true로 실행):
aith-hub pair <<'AITH_EOF'
(지시 내용 그대로)
AITH_EOF
끝났다는 알림이 오면 출력 파일을 읽어 내용을 요약하거나 고치지 말고 그대로 보여주세요. 덧붙일 말은 한 줄 이내로.
MSG
fi
exit 0
