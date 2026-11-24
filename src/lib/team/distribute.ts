// Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
// 팀 탭: 분배 담당(큰 지시 → 에이전트별 몫과 순서)과 목적 제안(목적 → 필요한 에이전트 목록).
// 호출은 단발(oneshot.ts — 분배 Sonnet, 구성 Opus), 여기는 프롬프트와 결과 정리.

import { ownsOverlap } from "$lib/collab/ownership";
import { LANE_MODELS, EFFORTS } from "$lib/pair/models";
import { uniqueName, type Member } from "./team";

/** 분배 결과 스키마. member는 에이전트 이름 중에서만(안 그러면 "Backend Developer" 같은 이름을 지어낸다 — 실측) */
export function distributeSchema(members: Member[]): object {
  return {
    type: "object",
    properties: {
      assign: {
        type: "array",
        items: {
          type: "object",
          properties: {
            member: { type: "string", enum: members.map((m) => m.name) },
            task: { type: "string" },
            // 이 몫을 시작하기 전에 끝나 있어야 하는 에이전트(그 결과물이 있어야 할 수 있는 일)
            after: { type: "array", items: { type: "string", enum: members.map((m) => m.name) } },
          },
          required: ["member", "task", "after"],
        },
      },
    },
    required: ["assign"],
  };
}

export const DISTRIBUTE_SYSTEM = "너는 개발 팀의 분배 담당이다. 지시를 읽고 에이전트별 몫과 순서를 정한다. 같은 일이나 같은 결과물을 둘 이상에게 주지 않는다. 코드를 보거나 고치지 않는다. JSON만 낸다.";

/** dirs: 프로젝트의 실제 폴더 목록(경로를 지어내지 않게) */
export function distributePrompt(instruction: string, members: Member[], dirs: string[] = []): string {
  const rows = members.map((m) => `- ${m.name}: ${m.purpose || "맡은 일 미지정"} · 경로 ${m.areas.join(", ") || "미지정"}`).join("\n");
  return `[에이전트]
${rows}
${dirs.length ? `\n[프로젝트 폴더(실제로 있는 것)]\n${dirs.slice(0, 200).join("\n")}\n` : ""}
[지시]
${instruction}

지시를 에이전트별 몫으로 나누고 순서를 정하라.
- 지시가 요구한 일만 나눈다. 지시에 없는 다음 단계(구현·테스트·빌드·배포 등)를 미리 맡기지 마라 — 예: "기획서 만들어"면 기획서까지만, 구현은 아무에게도 주지 않는다.
- 지시에 범위 제한("~만", "~까지만", "~는 하지 마", "아직 개발하지 마")이 있으면 그 범위 밖의 몫은 아무에게도 주지 않는다. 그 범위에 할 일이 없는 에이전트는 assign에서 뺀다.
- 몫이 있는 에이전트만 assign에 넣는다(member = 에이전트 이름 그대로). 할 일이 없는 에이전트는 넣지 않는다.
- 결과물(화면·API·실행 파일·테스트 묶음·문서 등)마다 맡는 에이전트는 한 에이전트뿐이다. 같은 결과물이나 같은 일을 둘에게 주지 마라.
- task는 그 에이전트가 바로 시작할 수 있게 구체적으로: 만들 결과물, 고칠 파일·폴더(위 폴더 목록에 있는 경로만 — 없는 경로를 지어내지 마라), 끝났다고 볼 기준.
- 다른 에이전트의 결과물이 있어야 할 수 있는 몫이면 after에 그 에이전트 이름을 넣어라. 그 에이전트가 끝난 뒤에 시작한다. 동시에 시켜서 가짜·대역·임시 복제본을 만들게 하지 마라.
- 서로 기다릴 필요가 없는 몫은 after를 비워 동시에 진행한다.
- 담당 경로가 겹치는 두 에이전트에게 같은 파일을 고치게 하지 마라. 한 에이전트에게 몰아라.`;
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** 겹침 판단에서 빼는 확장자 규칙(**\/*.svelte 같은 것 — 어디에나 걸려서 늘 겹쳐 보인다) */
const pathGlobs = (areas: string[]) => areas.filter((g) => !g.startsWith("**"));

/** 분배 결과 정리: 없는 에이전트·빈 몫은 버리고, 담당 경로가 겹치는 에이전트 둘에 모두 몫이 있으면 경고 */
export interface Assign {
  id: string;
  task: string;
  /** 먼저 끝나야 하는 에이전트 id(이번에 몫이 있는 에이전트만) */
  after: string[];
}

export function normalizeAssign(raw: unknown, members: Member[]): { assign: Assign[]; warn: string | null } {
  const list = (raw as { assign?: unknown } | null)?.assign;
  const assign: Assign[] = [];
  const names: Record<string, string[]> = {};
  if (Array.isArray(list)) {
    for (const x of list) {
      const name = typeof x?.member === "string" ? norm(x.member) : "";
      const task = typeof x?.task === "string" ? x.task.trim() : "";
      const m = members.find((y) => norm(y.name) === name);
      if (m && task && !assign.some((a) => a.id === m.id)) {
        assign.push({ id: m.id, task, after: [] });
        names[m.id] = Array.isArray(x.after) ? x.after.filter((a: unknown): a is string => typeof a === "string").map(norm) : [];
      }
    }
  }
  // after는 이번에 몫이 있는 다른 에이전트만(없는 이름·자기 자신·몫 없는 에이전트는 기다릴 수 없다)
  for (const a of assign) {
    a.after = [...new Set(names[a.id].map((n) => members.find((y) => norm(y.name) === n)?.id).filter((id): id is string => !!id && id !== a.id && assign.some((b) => b.id === id)))];
  }
  const picked = assign.map((a) => members.find((m) => m.id === a.id)!);
  const clash: string[] = [];
  for (let i = 0; i < picked.length; i++)
    for (let j = i + 1; j < picked.length; j++) {
      const a = pathGlobs(picked[i].areas), b = pathGlobs(picked[j].areas);
      if (a.length && b.length && ownsOverlap(a, b)) clash.push(`${picked[i].name}·${picked[j].name}`);
    }
  return { assign, warn: clash.length ? `담당 경로가 겹치는 에이전트가 함께 일해요: ${clash.join(", ")} — 같은 파일을 고치지 않게 살펴 주세요` : null };
}

/** 분배가 실패했거나 비었으면 모든 에이전트에 원래 지시 */
export function assignOrAll(r: { assign: Assign[] } | null, members: Member[], instruction: string): Assign[] {
  if (r && r.assign.length) return r.assign;
  return members.map((m) => ({ id: m.id, task: instruction, after: [] }));
}

/** 순서대로 단계 나누기: 앞 단계가 모두 끝난 뒤 다음 단계. 서로 기다리면(순환) 남은 것을 마지막 단계에 한꺼번에 */
export function stagesOf(list: { id: string; after?: string[] }[]): string[][] {
  const left = new Map(list.map((x) => [x.id, (x.after ?? []).filter((a) => list.some((y) => y.id === a))]));
  const done = new Set<string>();
  const out: string[][] = [];
  while (left.size) {
    const ready = [...left].filter(([, after]) => after.every((a) => done.has(a))).map(([id]) => id);
    if (!ready.length) {
      out.push([...left.keys()]);
      break;
    }
    out.push(ready);
    for (const id of ready) {
      done.add(id);
      left.delete(id);
    }
  }
  return out;
}

// ---------- 목적 제안 ----------

export const PROPOSE_MAX = 8;

export const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    agents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          cli: { type: "string", enum: ["claude", "codex"] },
          model: { type: "string" },
          effort: { type: "string" },
          purpose: { type: "string" },
          areas: { type: "array", items: { type: "string" } },
          task: { type: "string" },
        },
        required: ["name", "cli", "model", "effort", "purpose", "areas"],
      },
    },
  },
  required: ["agents"],
};

export const PROPOSE_SYSTEM = "너는 개발 팀 구성 담당이다. 목적과 폴더 구조를 보고 동시에 일할 에이전트들과 각자의 모델·생각 깊이를 정한다. 같은 일을 둘 이상에게 맡기지 않는다. 코드를 보거나 고치지 않는다. JSON만 낸다.";

/** 모델·생각 깊이 고르는 기준(구성 담당에게 보여 준다) */
/** 팀장·분배에 주는 모델 안내 — 모델 목록(Codex가 아는 새 모델 포함)에서 만든다 */
import { modelGuide } from "$lib/pair/models";
export { modelGuide };

/**
 * start: "목적대로 바로 시작" — 에이전트마다 바로 보낼 첫 작업 지시(task)도 쓰게 한다.
 * only: 이 AI(CLI)만 쓰게 한다(null이면 둘 다)
 */
export function proposePrompt(purpose: string, dirs: string[], members: Member[], start = false, only: "claude" | "codex" | null = null): string {
  const now = members.map((m) => `- ${m.name}(${m.cli}): ${m.purpose || "맡은 일 미지정"} · ${m.areas.join(", ") || "경로 미지정"}`).join("\n");
  return `[목적]
${purpose}

[폴더(세 단계까지)]
${dirs.slice(0, 300).join("\n") || "(비어 있음)"}

[지금 에이전트]
${now || "없음"}

목적을 빨리 끝내려면 지금 에이전트에 더해 몇 명이 필요한지 정하고, 각자 겹치지 않게 나눠라. 최대 ${PROPOSE_MAX}명, 꼭 필요한 만큼만(한 명이 할 수 있으면 한 명).
- name: 짧은 이름(한글 2~6자 또는 영문, @ 없이), 지금 에이전트와 겹치지 않게
- cli: ${only ? `${only}만 쓴다(사용자가 정함)` : "claude(화면·문서·리뷰에 강함) 또는 codex(백엔드·로직에 강함)"}
${modelGuide()}
- purpose: 맡을 일 한 줄. 같은 결과물을 둘에게 맡기지 않는다
- areas: 그 에이전트만 고칠 경로 글롭(폴더 목록에 있는 경로 기준, 예: web/login/**). 서로 겹치지 않게${start ? `
- task: 그 에이전트에게 지금 바로 보낼 첫 작업 지시. 목적을 이루려면 무엇을 만들어야 하는지 구체적으로(어느 폴더·파일, 무엇을, 끝났다고 볼 기준) 2~4문장. 다른 에이전트가 만들 것은 만들지 말고(가짜·대역 포함), 필요하면 인계로 요청하라고 적는다` : ""}`;
}

export type Draft = Omit<Member, "id" | "resume">;
/** 제안 한 줄: 에이전트 + "바로 시작"할 때 보낼 첫 작업(없으면 "") */
export type Proposal = Draft & { task: string };

/** 목적 제안 정리: 최대 8명, cli·모델·생각 깊이 보정(쓸 AI를 정했으면 그 CLI로), 이름 앞 @ 떼기·중복 피하기, 경로는 문자열만, 추가 에이전트는 lean */
export function normalizeProposal(raw: unknown, members: Member[], only: "claude" | "codex" | null = null): Proposal[] {
  const list = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list)) return [];
  const out: Proposal[] = [];
  for (const x of list) {
    if (out.length >= PROPOSE_MAX) break;
    // "@테스트"처럼 지으면 @이름으로 부르기 헷갈린다 → 앞의 @는 뗀다
    const name0 = typeof x?.name === "string" ? x.name.trim().replace(/^@+/, "").trim() : "";
    if (!name0) continue;
    const cli: "claude" | "codex" = only ?? (x.cli === "codex" ? "codex" : "claude");
    const model = typeof x.model === "string" && LANE_MODELS[cli].some((m) => m.id === x.model) ? x.model : "auto";
    const effort = typeof x.effort === "string" && x.effort && EFFORTS[cli].some((e) => e.id === x.effort) ? x.effort : undefined;
    const taken = [...members, ...out.map((d, i) => ({ ...d, id: `d${i}` }))];
    out.push({
      name: uniqueName(name0, taken),
      cli,
      model,
      ...(effort ? { effort } : {}),
      purpose: typeof x.purpose === "string" ? x.purpose.trim() : "",
      areas: Array.isArray(x.areas) ? x.areas.filter((a: unknown): a is string => typeof a === "string" && a.trim() !== "").map((a: string) => a.trim()) : [],
      lean: true,
      task: typeof x.task === "string" ? x.task.trim() : "",
    });
  }
  return out;
}
