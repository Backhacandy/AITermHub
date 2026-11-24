# AITermHub

**세션 수십 개를 켜 둬도 PC가 안 멈추는, 가벼운 Windows용 AI 세션 관리자**

Claude Code · Codex CLI를 프로젝트마다 탭으로 열어 두고 오가는 사람을 위한 앱이에요. 쉬는 세션은 알아서 잠들어 메모리를 돌려주고, 다시 돌아오면 같은 대화로 이어집니다.

[English](README.en.md) · [사용 설명](docs/guide/README.md) · [내려받기](https://github.com/Backhacandy/AITermHub/releases/latest) · 무료 · 오픈소스(AGPL-3.0)

<!-- MEASURE:START -->
<!-- MEASURE:END -->

## 왜 만들었나

프로젝트 여러 개를 오가며 AI CLI를 쓰다 보면 이런 악순환이 생겨요.

1. 세션을 다 켜 두면 **메모리가 찬다.**
2. 끄면 다시 켤 때 **지난 대화를 다시 읽느라 토큰이 든다.**
3. 그래서 안 끄게 되고, 1로 돌아간다.

AITermHub는 세션을 **가볍게 재우고, 싸게 다시 이어 주는** 쪽으로 이 고리를 끊어요.

## 하는 일

- **쉬는 세션 재우기** — 2분 쉬면 프로세스를 잠재우고 메모리를 돌려줘요. 1시간 넘게 쉬면 프로세스를 끄되 대화는 남겨요(서버의 프롬프트 캐시가 1시간이라 그 전에는 끄지 않아요).
- **비용을 따지는 압축** — 대화가 길어지면 "압축 안 해서 더 내는 비용"과 "압축 비용"을 비교해 알맞을 때 압축해요. 다시 이어 갈 때 끌고 다니는 대화가 짧아져요.
- **재시작해도 이어 하기** — 앱이나 PC를 껐다 켜도 하던 일을 같은 대화로 이어서 해요.
- **멈춘 명령 감지** — 에이전트가 실행한 명령이 제한 시간을 한참 넘겨 멈춰 있으면 풀고 이어서 하게 해요. "작업중"인데 실제로는 멈춘 세션을 "응답 없음"으로 보여 줘요.
- **한 화면에서** — Claude Code·Codex·터미널 탭, 세션별 메모리, 사용량(5시간·주간 한도)을 한곳에서 봐요.
- **가벼운 앱** — Tauri(Rust)로 만들어 앱 자체도 가벼워요.
- 그 밖에: 폰에서 이어 하기(Claude 원격 제어), 작업 끝 알림, 웹 미리보기 탭.

실험 기능(설정 → 실험 기능): 여러 에이전트를 나눠 맡기는 **팀 탭**과 Claude vs Codex **비교 탭**. 실측상 단일 세션보다 느리고 토큰을 더 쓸 수 있어 기본으로 꺼 뒀어요.

## 설치

1. [최신 릴리스](https://github.com/Backhacandy/AITermHub/releases/latest)에서 `AITermHub_…_x64-setup.exe`를 받아 실행해요.
2. **"Windows의 PC 보호" 경고**가 뜨면 **추가 정보 → 실행**을 눌러요. 개인 개발자라 아직 코드 서명 인증서(유료)가 없어서 뜨는 경고예요. 설치 파일은 이 저장소의 소스로 만든 그대로예요.
3. 처음 켜면 Claude Code나 Codex CLI가 설치돼 있는지 확인해 줘요. 둘 중 하나만 있어도 돼요.

새 버전이 나오면 앱 위쪽에 알림이 뜨고, 눌러야 설치돼요. 일하는 중이면 "일이 끝난 뒤"를 고를 수 있어요.

**요구 사항:** Windows 10/11 (x64), [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 또는 [Codex CLI](https://github.com/openai/codex)와 각자의 구독/로그인.

## 개인정보

- 사용 통계를 보내지 않아요.
- 앱이 밖으로 연결하는 것(업데이트 확인, 켰을 때만 동작하는 원격·알림·GitHub 기능)은 **설정 → 정보**에 모두 적혀 있어요.
- Claude·Codex 로그인 정보는 앱이 읽거나 옮기지 않아요. 각 CLI가 직접 다뤄요.

## 라이선스

[AGPL-3.0-or-later](LICENSE). 자유롭게 쓰고 고쳐도 돼요. 고친 버전을 배포하거나 네트워크 서비스로 제공하면 **그 소스도 같은 라이선스로 공개**해야 해요. Copyright (c) 2026 Backhacandy.

## 기여 · 피드백

- 버그·제안: [이슈](https://github.com/Backhacandy/AITermHub/issues/new/choose)
- 코드: [CONTRIBUTING.md](CONTRIBUTING.md) (기여 동의 포함)

## 개발

```bash
npm install
npm run tauri dev        # 개발판
npm test                 # 단위 테스트
npm run tauri:release    # 배포판 설치 파일
```
