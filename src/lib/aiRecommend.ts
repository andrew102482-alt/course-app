import { places, type PlaceCategory } from "../data/places.ts";
import type { CourseResult } from "./course.ts";

/** AI에게 보내는 후보 장소(추천 단계마다 점수 순 상위 몇 곳). */
export type AiCandidate = {
  id: string;
  name: string;
  subCategory?: string;
  rating: number;
  reviewCount: number;
  description: string;
  openTime: string;
  closeTime: string;
  /** 기본 추천 기준 이전 장소에서 걸어서 걸리는 분. 없으면 null. */
  travelMinutes: number | null;
};

export type AiStageInput = {
  id: string;
  kind: "recommend" | "designated";
  /** 추천 단계는 카테고리(+세부), 지정 단계는 장소 이름. */
  label: string;
  candidates: AiCandidate[];
};

export type AiRecommendRequest = {
  themeNote: string;
  startHour: number | null;
  endHour: number | null;
  planDate?: string;
  stages: AiStageInput[];
};

/** stage.id → AI가 고른 장소 id. */
export type AiPicks = Record<string, string>;

export const AI_MAX_CANDIDATES_PER_STAGE = 10;

/** 화면의 코스 계산 결과에서 AI 요청 본문을 만든다(후보는 평점·거리 점수 상위 몇 곳). */
export function buildAiRequest(
  baseline: CourseResult,
  input: Pick<
    AiRecommendRequest,
    "themeNote" | "startHour" | "endHour" | "planDate"
  >,
): AiRecommendRequest {
  const stages: AiStageInput[] = baseline.stages.map((result) => {
    if (result.kind === "designated") {
      return {
        id: result.stage.id,
        kind: "designated",
        label: result.selected.name,
        candidates: [],
      };
    }
    const { category, subCategory } = result.stage;
    return {
      id: result.stage.id,
      kind: "recommend",
      label: subCategory ? `${category} / ${subCategory}` : category,
      candidates: result.candidates
        .slice(0, AI_MAX_CANDIDATES_PER_STAGE)
        .map((c) => ({
          id: c.place.id,
          name: c.place.name,
          subCategory: c.place.subCategory,
          rating: c.place.rating,
          reviewCount: c.place.reviewCount,
          description: c.place.description,
          openTime: c.place.openTime,
          closeTime: c.place.closeTime,
          travelMinutes: c.travelMinutesFromPrevious,
        })),
    };
  });
  return { ...input, stages };
}

function formatHour(hour: number | null): string {
  if (hour === null) return "상관없음";
  const h = hour % 24;
  return `${hour >= 24 ? "다음날 " : ""}${String(h).padStart(2, "0")}:00`;
}

/** 모델에게 줄 지시문. */
export function buildPrompt(req: AiRecommendRequest): {
  system: string;
  user: string;
} {
  const system = [
    "너는 하루 데이트·나들이 코스를 짜 주는 도우미다.",
    "일정 단계마다 주어진 후보 목록 안에서만 장소를 정확히 하나씩 고른다. 목록에 없는 장소를 만들어 내면 안 된다.",
    "고를 때 지킬 것:",
    "1) 사용자가 적은 분위기·테마에 가장 잘 맞는 곳을 우선한다.",
    "2) 만나는 시간~헤어지는 시간 사이에서 각 단계가 대략 언제쯤인지 가늠해, 그 시각에 영업 중인 곳을 고른다(영업시간 openTime~closeTime, 24시간제).",
    "3) 평점이 높고, 이전 장소에서 가까운(travelMinutes가 작은) 곳을 선호한다.",
    "4) 같은 장소를 두 번 고르지 않는다.",
    "지정 단계(kind=designated)는 이미 정해진 장소이니 고르지 않는다. 다만 앞뒤 추천 단계를 고를 때 그 장소와 어울리게 고려한다.",
    "응답은 JSON만 출력한다.",
  ].join("\n");

  const lines: string[] = [];
  lines.push(`일정 날짜: ${req.planDate ?? "정하지 않음"}`);
  lines.push(`만나는 시간: ${formatHour(req.startHour)}`);
  lines.push(`헤어지는 시간: ${formatHour(req.endHour)}`);
  lines.push(
    `원하는 분위기·테마: ${req.themeNote.trim() ? req.themeNote.trim() : "(적지 않음)"}`,
  );
  lines.push("");
  lines.push("일정 단계(순서대로):");
  req.stages.forEach((stage, i) => {
    if (stage.kind === "designated") {
      lines.push(`${i + 1}. [지정] ${stage.label} (stageId: ${stage.id})`);
      return;
    }
    lines.push(`${i + 1}. [추천] ${stage.label} (stageId: ${stage.id})`);
    for (const c of stage.candidates) {
      lines.push(
        `   - placeId: ${c.id} | ${c.name}${c.subCategory ? ` (${c.subCategory})` : ""} | 평점 ${c.rating} (${c.reviewCount}명) | 영업 ${c.openTime}~${c.closeTime} | 이전 장소에서 ${c.travelMinutes ?? "-"}분 | ${c.description}`,
      );
    }
  });
  lines.push("");
  lines.push(
    '추천 단계마다 하나씩 골라 {"picks":[{"stageId":"...","placeId":"..."}]} 형식으로 답해라.',
  );
  return { system, user: lines.join("\n") };
}

/** 모델 응답(문자열)에서 picks를 꺼내고, 후보에 없거나 중복된 선택은 버린다. */
export function parsePicks(text: string, req: AiRecommendRequest): AiPicks {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return {};
    }
  }
  const list = (raw as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(list)) return {};

  const allowed = new Map<string, Set<string>>();
  for (const stage of req.stages) {
    if (stage.kind === "recommend") {
      allowed.set(stage.id, new Set(stage.candidates.map((c) => c.id)));
    }
  }

  const picks: AiPicks = {};
  const used = new Set<string>();
  for (const item of list) {
    const stageId = (item as { stageId?: unknown })?.stageId;
    const placeId = (item as { placeId?: unknown })?.placeId;
    if (typeof stageId !== "string" || typeof placeId !== "string") continue;
    if (picks[stageId] || used.has(placeId)) continue;
    if (!allowed.get(stageId)?.has(placeId)) continue;
    picks[stageId] = placeId;
    used.add(placeId);
  }
  return picks;
}

/** 일정 단계가 하나도 없을 때, AI에게 단계 자체를 짜 달라고 요청하는 본문. */
export type AiPlanRequest = {
  mode: "plan";
  themeNote: string;
  startHour: number | null;
  endHour: number | null;
  planDate?: string;
};

export type AiPlannedStage = { category: PlaceCategory; subCategory?: string };

export const AI_MAX_PLANNED_STAGES = 5;

/**
 * 실제로 장소가 있는 카테고리 → 세부 카테고리 목록.
 * AI가 장소가 없는 종류로 단계를 짜면 코스가 막히므로, 단계는 여기 있는 것만 쓰게 한다.
 */
export function availableCatalog(): Record<string, string[]> {
  const catalog: Record<string, Set<string>> = {};
  for (const place of places) {
    const subs = (catalog[place.category] ??= new Set());
    if (place.subCategory) subs.add(place.subCategory);
  }
  return Object.fromEntries(
    Object.entries(catalog).map(([category, subs]) => [category, [...subs]]),
  );
}

export function buildPlanPrompt(req: AiPlanRequest): {
  system: string;
  user: string;
} {
  const available = availableCatalog();
  const catalog = Object.entries(available)
    .map(([c, subs]) =>
      subs.length > 0
        ? `- ${c}: ${subs.join(", ")}`
        : `- ${c}: (세부 카테고리 없음)`,
    )
    .join("\n");
  const system = [
    "너는 하루 데이트·나들이 코스의 일정 단계를 짜 주는 도우미다.",
    `사용자가 적은 분위기·테마와 만나는/헤어지는 시간을 보고, 1~${AI_MAX_PLANNED_STAGES}개의 단계를 순서대로 정한다.`,
    "각 단계는 아래 카테고리 중 하나이고, 세부 카테고리는 그 카테고리에 속한 것만 고를 수 있다(꼭 필요 없으면 빈 문자열).",
    catalog,
    "시간이 길수록 단계를 늘리고(대략 한 단계에 1.5~2.5시간), 식사 시간대(점심·저녁)에는 맛집을 넣는 식으로 하루 흐름이 자연스럽게 한다.",
    "시간이 정해지지 않았으면 3개 안팎으로 정한다. 응답은 JSON만 출력한다.",
  ].join("\n");
  const user = [
    `일정 날짜: ${req.planDate ?? "정하지 않음"}`,
    `만나는 시간: ${formatHour(req.startHour)}`,
    `헤어지는 시간: ${formatHour(req.endHour)}`,
    `원하는 분위기·테마: ${req.themeNote.trim() ? req.themeNote.trim() : "(적지 않음)"}`,
    "",
    '{"stages":[{"category":"...","subCategory":"..."}]} 형식으로 답해라.',
  ].join("\n");
  return { system, user };
}

/** 모델 응답에서 단계 목록을 꺼낸다. 없는 카테고리·세부 카테고리는 버리거나 세부만 뺀다. */
export function parsePlan(text: string): AiPlannedStage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const list = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(list)) return [];

  const available = availableCatalog();
  const result: AiPlannedStage[] = [];
  for (const item of list) {
    const category = (item as { category?: unknown })?.category;
    const sub = (item as { subCategory?: unknown })?.subCategory;
    if (typeof category !== "string" || !(category in available)) continue;
    const cat = category as PlaceCategory;
    const subCategory =
      typeof sub === "string" && available[cat].includes(sub) ? sub : undefined;
    result.push({ category: cat, subCategory });
    if (result.length >= AI_MAX_PLANNED_STAGES) break;
  }
  return result;
}
