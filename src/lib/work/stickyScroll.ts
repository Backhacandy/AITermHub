// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 스크롤 규칙: 바닥을 보고 있으면 새 내용을 따라가고, 위를 보고 있으면 위치를 지킨다.

export function shouldStick(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 40): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 스크롤 이벤트 뒤 따라가기 상태. 끄는 건 사용자가 위로 올렸을 때(scrollTop이 줄었을 때)만이다.
 * 내용이 한꺼번에 많이 붙으면 바닥과 멀어진 채로 scroll 이벤트가 오는데, 이걸 "위를 본다"로 보면
 * 맨 아래를 따라가다 멈춰 버린다.
 */
export function nextStick(prev: boolean, lastTop: number, scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  if (shouldStick(scrollTop, scrollHeight, clientHeight)) return true;
  if (scrollTop < lastTop - 1) return false;
  return prev;
}

/**
 * el = 스크롤 컨테이너, inner = 내용(크기 변화 감지 대상).
 * 내용이 커질 때 atBottom이면 바닥으로 따라간다. 숨었다가 다시 보이면(탭 전환) 바닥으로.
 */
export class Sticky {
  atBottom = true;
  private ro: ResizeObserver;
  private lastClient = 0;
  private lastTop = 0;

  constructor(
    private el: HTMLElement,
    inner: HTMLElement,
    private onChange: (atBottom: boolean) => void
  ) {
    el.addEventListener("scroll", this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => {
      const shownAgain = this.lastClient === 0 && el.clientHeight > 0;
      this.lastClient = el.clientHeight;
      if (shownAgain || this.atBottom) this.toBottom();
    });
    this.ro.observe(inner);
    this.ro.observe(el);
  }

  private onScroll = () => {
    const top = this.el.scrollTop;
    const b = nextStick(this.atBottom, this.lastTop, top, this.el.scrollHeight, this.el.clientHeight);
    this.lastTop = top;
    if (b !== this.atBottom) {
      this.atBottom = b;
      this.onChange(b);
    }
  };

  toBottom() {
    this.el.scrollTop = this.el.scrollHeight;
    this.lastTop = this.el.scrollTop;
    if (!this.atBottom) {
      this.atBottom = true;
      this.onChange(true);
    }
  }

  destroy() {
    this.el.removeEventListener("scroll", this.onScroll);
    this.ro.disconnect();
  }
}
