import type { Place, PlaceCategory } from "@/data/places";

export type Stage = {
  id: string;
  category: PlaceCategory;
  subCategory?: string;
};

export type ScoredCandidate = {
  place: Place;
  score: number;
  travelMinutesFromPrevious: number | null;
  withinMaxTravel: boolean;
};

export type StageResult = {
  stage: Stage;
  selected: Place | null;
  travelMinutesFromPrevious: number | null;
  candidates: ScoredCandidate[];
};

export type CourseResult = {
  stages: StageResult[];
  totalTravelMinutes: number;
  success: boolean;
};

/** stage.id → 사용자가 직접 고른 장소 id. 자동 추천 대신 이 장소를 선택한다. */
export type StageOverrides = Record<string, string>;

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_MINUTE_WALKING = 67;
const DETOUR_FACTOR = 1.3;
const REVIEW_BONUS_WEIGHT = 0.5;
const REVIEW_BONUS_REFERENCE_COUNT = 2000;
const PROXIMITY_BONUS_WEIGHT = 0.5;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function straightLineDistanceMeters(a: Place, b: Place): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function walkingMinutesBetween(a: Place, b: Place): number {
  const distance = straightLineDistanceMeters(a, b);
  return (distance * DETOUR_FACTOR) / METERS_PER_MINUTE_WALKING;
}

function reviewBonus(reviewCount: number): number {
  const ratio =
    Math.log10(reviewCount + 1) / Math.log10(REVIEW_BONUS_REFERENCE_COUNT + 1);
  return Math.min(ratio, 1) * REVIEW_BONUS_WEIGHT;
}

function proximityBonus(
  travelMinutes: number | null,
  maxTravelMinutes: number,
): number {
  if (travelMinutes === null) return 0;
  const closeness = 1 - travelMinutes / maxTravelMinutes;
  return Math.max(closeness, 0) * PROXIMITY_BONUS_WEIGHT;
}

function scorePlace(
  place: Place,
  previous: Place | null,
  maxTravelMinutes: number,
): ScoredCandidate {
  const travelMinutesFromPrevious = previous
    ? walkingMinutesBetween(previous, place)
    : null;

  const score =
    place.rating +
    reviewBonus(place.reviewCount) +
    proximityBonus(travelMinutesFromPrevious, maxTravelMinutes);

  const withinMaxTravel =
    travelMinutesFromPrevious === null ||
    travelMinutesFromPrevious <= maxTravelMinutes;

  return { place, score, travelMinutesFromPrevious, withinMaxTravel };
}

function matchesStage(place: Place, stage: Stage): boolean {
  if (place.category !== stage.category) return false;
  if (!stage.subCategory) return true;
  return place.subCategory === stage.subCategory;
}

/**
 * 일정 단계 순서대로 장소를 하나씩 고른다. 각 단계의 후보 목록은 이전 장소
 * 기준 평점·리뷰 수·거리로 점수를 매겨 정렬하고, 그중 최대 이동시간 이내인
 * 후보 중 1등을 자동으로 선택한다(교체용으로 전체 후보도 함께 돌려준다).
 * `overrides`로 특정 단계에 사용자가 고른 장소를 강제로 선택할 수 있다.
 * 이미 선택된 장소는 다음 단계 후보에서 제외한다.
 */
export function buildCourse(
  stages: Stage[],
  places: Place[],
  maxTravelMinutes: number,
  overrides: StageOverrides = {},
): CourseResult {
  const usedPlaceIds = new Set<string>();
  let previous: Place | null = null;
  const stageResults: StageResult[] = [];

  for (const stage of stages) {
    const pool = places.filter(
      (place) => matchesStage(place, stage) && !usedPlaceIds.has(place.id),
    );

    const candidates = pool
      .map((place) => scorePlace(place, previous, maxTravelMinutes))
      .sort((a, b) => b.score - a.score);

    const overridePlaceId = overrides[stage.id];
    const overrideCandidate = overridePlaceId
      ? candidates.find((c) => c.place.id === overridePlaceId)
      : undefined;

    const chosen =
      overrideCandidate ?? candidates.find((c) => c.withinMaxTravel);
    const selected = chosen?.place ?? null;

    stageResults.push({
      stage,
      selected,
      travelMinutesFromPrevious: chosen?.travelMinutesFromPrevious ?? null,
      candidates,
    });

    if (selected) {
      usedPlaceIds.add(selected.id);
      previous = selected;
    }
    // selected가 없어도 previous는 유지한다: 다음 단계는 마지막으로
    // 선택된 실제 장소를 기준으로 거리·이동시간을 계산해야 한다.
  }

  const totalTravelMinutes = stageResults.reduce(
    (sum, result) => sum + (result.travelMinutesFromPrevious ?? 0),
    0,
  );

  return {
    stages: stageResults,
    totalTravelMinutes,
    success: stageResults.every((result) => result.selected !== null),
  };
}
