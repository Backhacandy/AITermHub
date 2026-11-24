// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 스트림 이벤트(글자 조각·도구 입력 조각)를 잠깐 모아 한 번에 처리한다.
// 조각마다 처리하면 답 전체 마크다운 변환·라이브 코드 뷰 비교·스크롤이 초당 수십 번 돌아 앱이 버벅인다.
// 한 작업(task) 안에서 처리하면 Svelte가 화면을 한 번만 갱신한다.

export interface Batcher<T> {
  push(item: T): void;
  /** 모아 둔 것을 지금 처리(종료·오류 이벤트처럼 순서가 중요한 것 앞에서) */
  flush(): void;
  dispose(): void;
}

export function batcher<T>(handle: (item: T) => void, ms = 80, after?: () => void): Batcher<T> {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!queue.length) return;
    const items = queue;
    queue = [];
    for (const it of items) {
      try {
        handle(it);
      } catch {}
    }
    after?.();
  }
  return {
    push(item) {
      queue.push(item);
      timer ??= setTimeout(flush, ms);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      queue = [];
    },
  };
}
