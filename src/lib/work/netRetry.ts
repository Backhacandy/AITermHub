// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 와이파이가 끊기거나 절전에서 깨어나 Claude 차례가 연결 오류로 끝났을 때: 다시 연결되면 같은 대화로 이어서 하게 한다.
// (Claude CLI는 자체 재시도 몇 번 뒤 "API Error: Connection error." 같은 오류로 차례를 끝낸다)

/** 연결 끊김·시간 초과·서버 일시 오류(5xx·과부하) — 기다렸다 이어서 하면 되는 오류인지 */
export function isNetError(text: string | null | undefined): boolean {
  if (!text) return false;
  return /connection error|request timed out|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|socket hang up|network ?error|unable to connect|ConnectionRefused|stream (disconnected|closed)|overloaded|API Error: 5\d\d/i.test(text);
}

/** 이어서 할 때 보내는 말(같은 지시를 다시 보내면 처음부터 다시 할 수 있어서) */
export const NET_CONTINUE =
  "(네트워크 연결이 끊겨 방금 차례가 중간에 멈췄어요. 다시 연결됐으니 처음부터 다시 하지 말고, 하던 작업을 끊긴 지점부터 이어서 마무리해 주세요.)";

/** 연달아 이어서 하기 최대 횟수(성공하면 처음부터 다시 센다) */
export const NET_MAX = 8;

/** n번째 시도 전에 기다리는 시간: 15초부터 두 배씩, 최대 5분 */
export function retryDelay(n: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, n - 1), 300_000);
}

export interface NetRetryDeps {
  /** 같은 대화로 이어서 보내기 */
  retry: () => Promise<void>;
  note: (text: string) => void;
  online?: () => boolean;
  /** 다시 연결되면 부를 함수 등록 → 해제 함수 */
  onOnline?: (cb: () => void) => () => void;
  /** n번째 시도 전 기다리는 시간(기본 retryDelay) */
  delay?: (n: number) => number;
}

const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
function browserOnOnline(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", cb);
  return () => window.removeEventListener("online", cb);
}

export function createNetRetry(deps: NetRetryDeps) {
  const online = deps.online ?? browserOnline;
  const onOnline = deps.onOnline ?? browserOnOnline;
  const wait = deps.delay ?? retryDelay;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | undefined;
  let waiting = false;

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    off?.();
    off = undefined;
    waiting = false;
  }

  function later() {
    timer = setTimeout(() => {
      clear();
      deps.retry().catch((e) => deps.note(`— 이어서 보내지 못했어요: ${e} —`));
    }, wait(tries));
  }

  return {
    get waiting() {
      return waiting;
    },
    /** 연결 오류로 차례가 끝남 → 이어서 하기를 예약했으면 true(횟수를 넘으면 false — 오류로 보여 준다) */
    fail(): boolean {
      clear();
      if (tries >= NET_MAX) return false;
      tries += 1;
      waiting = true;
      if (online()) {
        deps.note(`— 연결이 끊겼어요. ${Math.round(wait(tries) / 1000)}초 뒤 같은 대화로 이어서 할게요 (${tries}/${NET_MAX}) —`);
        later();
      } else {
        deps.note(`— 인터넷 연결이 끊겼어요. 다시 연결되면 같은 대화로 이어서 할게요 (${tries}/${NET_MAX}) —`);
        off = onOnline(() => {
          off?.();
          off = undefined;
          later();
        });
      }
      return true;
    },
    /** 차례가 제대로 끝남 */
    ok() {
      tries = 0;
    },
    /** 사용자가 새로 보내거나 멈춤·탭 닫음 */
    cancel() {
      clear();
      tries = 0;
    },
  };
}
export type NetRetry = ReturnType<typeof createNetRetry>;
