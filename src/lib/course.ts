import type { Place, PlaceCategory } from "@/data/places";

export type RecommendStage = {
  id: string;
  kind: "recommend";
  category: PlaceCategory;
  subCategory?: string;
  /** 일정 맨 앞의 출발지 칸이면 true(지우거나 순서를 옮길 수 없다). */
  isOrigin?: boolean;
};

/** 사용자가 검색(또는 임시 입력)으로 직접 고른, 추천하지 않고 그대로 코스에 넣는 장소. */
export type DesignatedPlace = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

export type DesignatedStage = {
  id: string;
  kind: "designated";
  place: DesignatedPlace;
  /** 일정 맨 앞에 기본으로 놓이는 출발지 단계. 지우거나 순서를 옮길 수 없고, 장소만 바꿀 수 있다. */
  isOrigin?: boolean;
};

export type Stage = RecommendStage | DesignatedStage;

export type ScoredCandidate = {
  place: Place;
  score: number;
  travelMinutesFromPrevious: number | null;
  withinMaxTravel: boolean;
};

export type RecommendStageResult = {
  kind: "recommend";
  stage: RecommendStage;
  selected: Place | null;
  travelMinutesFromPrevious: number | null;
  candidates: ScoredCandidate[];
  /** 후보는 있었지만(이전 장소 기준) 다음 지정 장소와의 거리 때문에 전부 제외된 경우. */
  blockedByDesignated: boolean;
  /** 일정 날짜가 정기 휴무 요일이라 후보에서 자동으로 빠진 장소 수. */
  closedExcludedCount: number;
  /** 도착 예정 시각이 운영 시간 밖이라 후보에서 빠진 장소 수(만나는 시간을 정했을 때만). */
  hoursExcludedCount: number;
  /** 이 단계 장소에 도착할 예정 시각(분, 0=자정, 24시간 넘으면 다음날). 만나는 시간이 없으면 null. */
  arrivalMinutes: number | null;
};

export type DesignatedStageResult = {
  kind: "designated";
  stage: DesignatedStage;
  selected: DesignatedPlace;
  travelMinutesFromPrevious: number | null;
  /** 바로 앞 단계도 지정 장소이고, 그 구간이 최대 이동시간을 넘는 경우(코스는 그대로 만들고 경고만). */
  travelExceedsMax: boolean;
  /** 도착 예정 시각(분). 만나는 시간이 없으면 null. */
  arrivalMinutes: number | null;
};

export type StageResult = RecommendStageResult | DesignatedStageResult;

export type CourseResult = {
  stages: StageResult[];
  totalTravelMinutes: number;
  success: boolean;
  /** 마지막 장소에서 머무는 시간까지 더한 예상 종료 시각(분). 만나는 시간이 없으면 null. */
  estimatedEndMinutes: number | null;
  /** 예상 종료 시각이 헤어지는 시간보다 늦으면 true. */
  exceedsEndTime: boolean;
};

/** 만나는/헤어지는 시간(시 단위, 0~35. 24 이상은 다음날). 정하지 않으면 null. */
export type TimeWindow = { startHour: number | null; endHour: number | null };

/** stage.id → 사용자가 직접 고른 장소 id. 추천 단계에서 자동 추천 대신 이 장소를 선택한다. */
export type StageOverrides = Record<string, string>;

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_MINUTE_WALKING = 67;
const DETOUR_FACTOR = 1.3;
const REVIEW_BONUS_WEIGHT = 0.5;
const REVIEW_BONUS_REFERENCE_COUNT = 2000;
const PROXIMITY_BONUS_WEIGHT = 0.5;

/** 장소에 머무는 시간(분) 가정. 시간대 계산용 임시 기준값. */
const STAY_MINUTES: Record<string, number> = {
  "문화 생활": 90,
  액티비티: 90,
  맛집: 60,
  카페: 60,
  술집: 90,
  쇼핑: 60,
};
const DEFAULT_STAY_MINUTES = 60;
/** 마감 직전 도착을 막기 위해, 도착 후 최소 이만큼은 영업 중이어야 한다. */
const MIN_OPEN_AFTER_ARRIVAL = 30;

export function stayMinutesFor(category: string): number {
  return STAY_MINUTES[category] ?? DEFAULT_STAY_MINUTES;
}

function clockToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** 도착 시각(분)에 영업 중인지. 마감이 자정을 넘기는 곳(마감 ≤ 시작)은 다음날로 계산한다. */
export function isOpenAt(place: Place, arrivalMinutes: number): boolean {
  const open = clockToMinutes(place.openTime);
  let close = clockToMinutes(place.closeTime);
  if (close <= open) close += 24 * 60;
  return arrivalMinutes >= open && arrivalMinutes + MIN_OPEN_AFTER_ARRIVAL <= close;
}

/** 1차 추천 데이터 범위(종로 일대) 중심과 반경. 지정 장소가 이 범위 밖인지 확인할 때 쓴다. */
export const REGION_CENTER = { lat: 37.5759, lng: 126.9825 };
export const REGION_RADIUS_METERS = 2200;

type LatLng = { lat: number; lng: number };

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function straightLineDistanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function walkingMinutesBetween(a: LatLng, b: LatLng): number {
  const distance = straightLineDistanceMeters(a, b);
  return (distance * DETOUR_FACTOR) / METERS_PER_MINUTE_WALKING;
}

export function isWithinRegionRange(point: LatLng): boolean {
  return straightLineDistanceMeters(point, REGION_CENTER) <= REGION_RADIUS_METERS;
}

export function naverMapLinkFor(place: DesignatedPlace): string {
  return `https://map.naver.com/p/search/${encodeURIComponent(place.name)}?c=${place.lng},${place.lat},15,0,0,0,dh`;
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

/** "YYYY-MM-DD" 날짜의 요일(0=일 … 6=토). 형식이 틀리면 null. */
export function weekdayOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

/** 일정 날짜가 이 장소의 정기 휴무 요일이면 true. 날짜가 없거나 형식이 틀리면 false. */
export function isClosedOn(place: Place, date: string | undefined): boolean {
  if (!date) return false;
  const weekday = weekdayOf(date);
  return weekday !== null && place.closedDays.includes(weekday);
}

function matchesStage(place: Place, stage: RecommendStage): boolean {
  if (place.category !== stage.category) return false;
  if (!stage.subCategory) return true;
  return place.subCategory === stage.subCategory;
}

function scoreCandidate(
  place: Place,
  previous: LatLng | null,
  nextDesignated: LatLng | null,
  maxTravelMinutes: number,
): ScoredCandidate {
  const travelMinutesFromPrevious = previous
    ? walkingMinutesBetween(previous, place)
    : null;
  const travelMinutesToNextDesignated = nextDesignated
    ? walkingMinutesBetween(place, nextDesignated)
    : null;

  const withinMaxTravel =
    (travelMinutesFromPrevious === null ||
      travelMinutesFromPrevious <= maxTravelMinutes) &&
    (travelMinutesToNextDesignated === null ||
      travelMinutesToNextDesignated <= maxTravelMinutes);

  const score =
    place.rating +
    reviewBonus(place.reviewCount) +
    proximityBonus(travelMinutesFromPrevious, maxTravelMinutes) +
    proximityBonus(travelMinutesToNextDesignated, maxTravelMinutes);

  return { place, score, travelMinutesFromPrevious, withinMaxTravel };
}

/**
 * 일정 단계 순서대로 장소를 하나씩 정한다.
 * - **지정 단계**는 추천하지 않고 그 장소를 그대로 코스에 넣는다.
 * - **추천 단계**는 예시 데이터에서 고르되, 이전 장소에서 최대 이동시간을 넘는
 *   후보는 제외한다. 바로 다음 단계가 지정 장소면 그 장소까지의 거리도 함께
 *   조건·점수에 반영한다(양쪽 기준). 평점·리뷰 수·거리로 점수를 매겨 정렬하고
 *   그중 범위 안 1등을 자동 선택한다(교체용으로 전체 후보도 함께 돌려준다).
 * - 지정 장소끼리 바로 이어진 구간이 최대 이동시간을 넘으면 실패시키지 않고
 *   경고 정보만 표시한다.
 * - `overrides`로 특정 추천 단계에 사용자가 고른 장소를 강제로 선택할 수 있다.
 * - 이미 선택된(추천) 장소는 다음 추천 단계 후보에서 제외한다.
 * - `planDate`(일정 날짜)가 정기 휴무 요일인 장소는 후보에서 자동으로 제외한다.
 * - `time.startHour`(만나는 시간)가 있으면 시계를 돌려, 도착 예정 시각에 영업 중이지
 *   않은 후보를 제외한다. `time.endHour`(헤어지는 시간)는 예상 종료 시각이 넘는지
 *   경고에만 쓴다(코스는 그대로 만든다).
 */
export function buildCourse(
  stages: Stage[],
  places: Place[],
  maxTravelMinutes: number,
  overrides: StageOverrides = {},
  planDate?: string,
  time: TimeWindow = { startHour: null, endHour: null },
): CourseResult {
  const usedPlaceIds = new Set<string>();
  let previous: LatLng | null = null;
  const stageResults: StageResult[] = [];
  // 시계: 만나는 시간을 정했을 때만 단계별 도착·영업 여부를 계산한다.
  let clock: number | null = time.startHour === null ? null : time.startHour * 60;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];

    if (stage.kind === "designated") {
      const travelMinutesFromPrevious = previous
        ? walkingMinutesBetween(previous, stage.place)
        : null;
      const previousStage = stages[i - 1];
      const travelExceedsMax =
        previousStage?.kind === "designated" &&
        travelMinutesFromPrevious !== null &&
        travelMinutesFromPrevious > maxTravelMinutes;

      if (clock !== null) clock += travelMinutesFromPrevious ?? 0;
      const arrivalMinutes = clock === null ? null : Math.round(clock);
      if (clock !== null) clock += DEFAULT_STAY_MINUTES;

      stageResults.push({
        kind: "designated",
        stage,
        selected: stage.place,
        travelMinutesFromPrevious,
        travelExceedsMax,
        arrivalMinutes,
      });

      previous = stage.place;
      continue;
    }

    const nextStage = stages[i + 1];
    const nextDesignated =
      nextStage?.kind === "designated" ? nextStage.place : null;

    const matching = places.filter(
      (place) => matchesStage(place, stage) && !usedPlaceIds.has(place.id),
    );
    const openByDay = matching.filter((place) => !isClosedOn(place, planDate));
    const closedExcludedCount = matching.length - openByDay.length;

    // 만나는 시간을 정했다면, 이 후보까지 걸어서 도착할 시각에 영업 중인 곳만 남긴다.
    const arrivalAt = (place: Place): number | null =>
      clock === null
        ? null
        : clock + (previous ? walkingMinutesBetween(previous, place) : 0);
    const pool = openByDay.filter((place) => {
      const arrival = arrivalAt(place);
      return arrival === null || isOpenAt(place, arrival);
    });
    const hoursExcludedCount = openByDay.length - pool.length;

    const candidates = pool
      .map((place) => scoreCandidate(place, previous, nextDesignated, maxTravelMinutes))
      .sort((a, b) => b.score - a.score);

    const overridePlaceId = overrides[stage.id];
    const overrideCandidate = overridePlaceId
      ? candidates.find((c) => c.place.id === overridePlaceId)
      : undefined;

    const chosen =
      overrideCandidate ?? candidates.find((c) => c.withinMaxTravel);
    const selected = chosen?.place ?? null;

    const withinPreviousOnly = candidates.filter(
      (c) =>
        c.travelMinutesFromPrevious === null ||
        c.travelMinutesFromPrevious <= maxTravelMinutes,
    );
    const blockedByDesignated =
      selected === null && nextDesignated !== null && withinPreviousOnly.length > 0;

    stageResults.push({
      kind: "recommend",
      stage,
      selected,
      travelMinutesFromPrevious: chosen?.travelMinutesFromPrevious ?? null,
      candidates,
      blockedByDesignated,
      closedExcludedCount,
      hoursExcludedCount,
      arrivalMinutes: selected && clock !== null ? Math.round(arrivalAt(selected) ?? clock) : null,
    });

    if (selected) {
      if (clock !== null) {
        clock = (arrivalAt(selected) ?? clock) + stayMinutesFor(selected.category);
      }
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

  const success = stageResults.every((result) => result.selected !== null);

  const estimatedEndMinutes = clock === null ? null : Math.round(clock);
  const exceedsEndTime =
    estimatedEndMinutes !== null &&
    time.endHour !== null &&
    estimatedEndMinutes > time.endHour * 60;

  return {
    stages: stageResults,
    totalTravelMinutes,
    success,
    estimatedEndMinutes,
    exceedsEndTime,
  };
}
