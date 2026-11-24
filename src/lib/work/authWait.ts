// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// Claude 로그인이 풀렸을 때(토큰 취소·갱신 실패·로그인 만료): 로그인 창을 한 번 열어 알리고,
// 그 계정의 로그인 정보 파일이 새로 바뀌면(다시 로그인·다른 세션의 갱신) 기다리던 세션을 간격을 두고 차례로 이어서 하게 한다.
// 같은 로그인으로 세션이 여럿이라 한꺼번에 깨우면 다시 동시에 갱신하다 꼬일 수 있어서 간격을 둔다.

/** "login" = 다시 로그인해야 함, "expired" = 액세스 토큰만 만료(다시 시작하면 스스로 갱신), null = 인증 오류 아님 */
export function authKind(text: string | null | undefined): "login" | "expired" | null {
  if (!text) return null;
  if (/revoked|could not be refreshed|login expired|please run \/login|not logged in|invalid api key|invalid_grant/i.test(text)) return "login";
  if (/OAuth access token has expired|authentication_error|Failed to authenticate|API Error: 401/i.test(text)) return "expired";
  return null;
}

export interface AuthDeps {
  /** 그 계정 로그인 정보 파일의 수정 시각(ms, 없으면 null) — 내용은 읽지 않는다 */
  stamp: (account: string | null) => Promise<number | null>;
  /** 그 계정 로그인 창 열기 */
  openLogin: (account: string | null) => void;
  /** PC 알림 */
  alert: (text: string) => void;
  now?: () => number;
  pollMs?: number;
  staggerMs?: number;
}

interface Waiter {
  account: string | null;
  resume: () => Promise<void>;
}

export function createAuthWaiter(deps: AuthDeps) {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 10_000;
  const staggerMs = deps.staggerMs ?? 3_000;
  const waiters = new Set<Waiter>();
  /** 계정별: 로그인이 풀렸을 때의 파일 시각(이보다 새로 바뀌면 다시 로그인된 것) */
  const base = new Map<string, number | null | "pending">();
  const opened = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const key = (a: string | null) => a ?? "";

  async function poll() {
    for (const k of [...new Set([...waiters].map((w) => key(w.account)))]) {
      const acc = k || null;
      const b = base.get(k);
      if (b === "pending") continue; // 풀렸을 때의 시각을 아직 못 읽음
      const s = await deps.stamp(acc).catch(() => null);
      if (s === null || (typeof b === "number" && s <= b)) continue;
      // 다시 로그인됨 → 이 계정을 기다리던 세션을 간격을 두고 차례로
      const list = [...waiters].filter((w) => key(w.account) === k);
      list.forEach((w) => waiters.delete(w));
      base.delete(k);
      list.forEach((w, i) => {
        const go = () => void w.resume().catch(() => {});
        if (i === 0) go();
        else setTimeout(go, i * staggerMs);
      });
    }
    if (!waiters.size) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    /** 로그인을 기다리는 세션이 있는지 */
    get lost() {
      return waiters.size > 0;
    },
    /** 인증 오류로 멈춘 세션 하나 등록 → 취소 함수 */
    wait(account: string | null, kind: "login" | "expired", resume: () => Promise<void>): () => void {
      if (kind === "expired") {
        // 액세스 토큰만 만료: 잠시 뒤 다시 시작하면 CLI가 스스로 갱신한다
        const t = setTimeout(() => void resume().catch(() => {}), pollMs);
        return () => clearTimeout(t);
      }
      const k = key(account);
      const w: Waiter = { account, resume };
      const first = ![...waiters].some((x) => key(x.account) === k);
      waiters.add(w);
      if (first) {
        if (!base.has(k)) {
          base.set(k, "pending");
          void deps.stamp(account).catch(() => null).then((s) => base.get(k) === "pending" && base.set(k, s));
        }
        // 로그인 창은 5분에 한 번까지(여러 세션이 연달아 실패해도 한 번만)
        if (now() - (opened.get(k) ?? -Infinity) > 5 * 60_000) {
          opened.set(k, now());
          deps.openLogin(account);
          deps.alert("Claude 로그인이 풀려 작업이 멈췄어요. 열린 로그인 창에서 다시 로그인하면 멈춘 작업이 모두 이어서 진행돼요");
        }
      }
      timer ??= setInterval(() => void poll(), pollMs);
      return () => {
        waiters.delete(w);
        if (!waiters.size && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}
export type AuthWaiter = ReturnType<typeof createAuthWaiter>;
