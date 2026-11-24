// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 포트폴리오 올리기(gh): 프로젝트 정보를 모아 보이기로 고른 것만 표로 만들고, 프로필 README의 표시 사이만 바꿔 올린다.
import { invoke } from "@tauri-apps/api/core";
import { quickJson } from "$lib/team/oneshot";
import { visibleItems, renderBlock, mergeReadme, dueDaily, planPublish, type ProjectInfo, type ProjectPref } from "$lib/portfolio";

export interface Profile {
  login: string;
  exists: boolean;
  sha: string;
  content: string;
}

export interface PortfolioSettings {
  portfolioOn?: boolean;
  portfolio?: Record<string, ProjectPref>;
  portfolioAt?: number;
  grassDirs?: string[];
}

export const scanProjects = (dirs: string[]) => invoke<ProjectInfo[]>("portfolio_scan", { dirs });
export const getProfile = () => invoke<Profile>("gh_profile_get");
export const createProfile = () => invoke<string>("gh_profile_create");

const today = () => new Date().toLocaleDateString("sv-SE");

/** 지금 올리기 → 결과 글. 보일 게 없으면 이미 올린 목록이 있을 때만 비우고, 목록이 그대로면 올리지 않는다 */
export async function publishPortfolio(s: PortfolioSettings, save: () => void): Promise<string> {
  const scan = await scanProjects(s.grassDirs ?? []);
  const items = visibleItems(scan, s.portfolio ?? {});
  const p = await getProfile();
  if (!p.exists) throw new Error(`프로필 저장소(${p.login}/${p.login})가 없어요 — '프로필 저장소 만들기'를 먼저 눌러 주세요`);
  const block = renderBlock(items, today());
  const plan = planPublish(items.length, p.content, block);
  if (plan === "skip") throw new Error("목록에 보일 프로젝트가 없어요 — '보이기'를 골라 주세요");
  if (plan !== "same") await invoke<string>("gh_profile_put", { content: mergeReadme(p.content, block, p.login), sha: p.sha });
  s.portfolioAt = Date.now();
  save();
  const url = `https://github.com/${p.login}`;
  return plan === "same" ? `바뀐 게 없어요 — ${url}` : items.length ? `올렸어요 — ${url}` : `목록을 비웠어요 — ${url}`;
}

/** 한 줄 설명 초안(Haiku) — README 앞부분을 글로 넘긴다 */
export async function draftDesc(p: ProjectInfo): Promise<string> {
  const r = await quickJson<{ desc: string }>(
    p.dir,
    "너는 포트폴리오 소개글을 쓰는 사람이다. 주어진 정보만으로 쓰고 과장하지 않는다. JSON만 낸다.",
    `면접관에게 이 프로젝트를 소개하는 한 줄(한국어, 40자 이내, 무엇을 만든 것인지)을 써라.\n이름: ${p.name}\n기술: ${p.tech.join(", ") || "모름"}\n[README 앞부분]\n${p.readme || "(없음)"}`,
    { type: "object", additionalProperties: false, required: ["desc"], properties: { desc: { type: "string" } } },
    "haiku",
  );
  return r?.desc?.trim() ?? "";
}

let timer: ReturnType<typeof setInterval> | undefined;
/** 켜 둔 동안 하루 한 번 올린다(30분마다 확인). 화면에서 고르는 중인(저장하지 않은) 값이 아니라 저장된 설정으로만 —
 *  "보이기"를 눌러 보기만 한 프로젝트가 자동으로 공개되지 않게. 실패하면 6시간 뒤에 다시 */
let failedAt = 0;
export function startPortfolio(onDone: (at: number) => void) {
  if (timer) return;
  const tick = async () => {
    if (Date.now() - failedAt < 6 * 3600_000) return;
    const disk = await invoke<PortfolioSettings>("settings_get").catch(() => null);
    if (!disk?.portfolioOn || !dueDaily(disk.portfolioAt, Date.now())) return;
    try {
      await publishPortfolio(disk, () => {});
      onDone(disk.portfolioAt ?? Date.now());
    } catch {
      failedAt = Date.now();
    }
  };
  setTimeout(tick, 5 * 60_000);
  timer = setInterval(tick, 30 * 60_000);
}
