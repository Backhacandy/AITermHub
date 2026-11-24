# 기여하기 / Contributing

AITermHub에 관심 가져 주셔서 고마워요. 버그 신고·제안은 [이슈](https://github.com/Backhacandy/AITermHub/issues/new/choose)로, 코드는 풀 리퀘스트로 보내 주세요.

## 기여 동의 (CLA)

풀 리퀘스트를 보내면 아래에 동의한 것으로 봐요. PR 템플릿의 체크박스에 표시해 주세요.

1. 보내는 코드·문서는 내가 직접 만들었거나, 보낼 권리가 있다.
2. 기여분은 이 저장소의 라이선스(AGPL-3.0-or-later)로 공개된다.
3. 저작권자(Backhacandy)는 기여분을 포함한 AITermHub를 **다른 라이선스로도 배포할 수 있는 권리**(재라이선스)를 가진다. 기여자는 이 권리를 영구적·취소 불가능하게, 무상으로 준다.
4. 기여자의 저작권은 기여자에게 남는다(위 권리를 주는 것일 뿐, 저작권을 넘기는 것은 아님).

---

Thanks for your interest. Please file bugs and ideas as [issues](https://github.com/Backhacandy/AITermHub/issues/new/choose) and send code as pull requests.

**Contributor License Agreement.** By opening a pull request you agree that: (1) you wrote the contribution or have the right to submit it; (2) it is published under this repository's license (AGPL-3.0-or-later); (3) you grant the copyright holder (Backhacandy) a perpetual, irrevocable, royalty-free right to distribute your contribution as part of AITermHub under other licenses as well (relicensing); (4) you keep your copyright — this is a license grant, not an assignment.

## 개발 / Development

```bash
npm install
npm run tauri dev          # 개발판 / dev build
npm test                   # 단위 테스트 / unit tests
cd src-tauri && cargo test # Rust 테스트
npm run tauri:release      # 배포판 설치 파일 / release installer
```

새 소스 파일에는 저작권 머리글이 필요해요: `node scripts/add-headers.mjs`.
