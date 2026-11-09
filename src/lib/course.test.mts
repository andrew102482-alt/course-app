import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCourse,
  isClosedOn,
  isWithinRegionRange,
  proximityBonus,
  reviewBonus,
  straightLineDistanceMeters,
  walkingMinutesBetween,
  type DesignatedStage,
  type RecommendStage,
  type Stage,
} from "./course.ts";
import { places, type Place } from "../data/places.ts";

function place(overrides: Partial<Place> & Pick<Place, "id">): Place {
  return {
    name: overrides.id,
    region: "종로",
    category: "맛집",
    lat: 37.5742,
    lng: 126.9845,
    rating: 4.0,
    reviewCount: 100,
    description: "",
    openTime: "10:00",
    closeTime: "21:00",
    closedDays: [],
    ...overrides,
  };
}

function recommend(
  id: string,
  category: RecommendStage["category"],
  subCategory?: string,
): RecommendStage {
  return { id, kind: "recommend", category, subCategory };
}

function designated(
  id: string,
  overrides: Partial<DesignatedStage["place"]> = {},
): DesignatedStage {
  return {
    id,
    kind: "designated",
    place: {
      id: `${id}-place`,
      name: id,
      address: "종로구 어딘가",
      lat: 37.5742,
      lng: 126.9845,
      ...overrides,
    },
  };
}

test("같은 지점의 거리와 이동시간은 0이다", () => {
  const a = { lat: 37.5742, lng: 126.9845 };
  assert.equal(straightLineDistanceMeters(a, a), 0);
  assert.equal(walkingMinutesBetween(a, a), 0);
});

test("약 110m 떨어진 두 지점의 도보 시간은 1.3배 가산된 값과 같다", () => {
  const a = { lat: 37.5742, lng: 126.9845 };
  const b = { lat: 37.5752, lng: 126.9845 }; // 위도 0.001 차이 ≈ 111m
  const distance = straightLineDistanceMeters(a, b);
  const expectedMinutes = (distance * 1.3) / 67;

  assert.ok(Math.abs(distance - 111) < 5);
  assert.equal(walkingMinutesBetween(a, b), expectedMinutes);
});

test("'전시 → 맛집(일식) → 카페' 코스는 15분 기준으로 3곳을 모두 추천한다 (지정 장소 없음)", () => {
  const stages: Stage[] = [
    recommend("s1", "문화 생활"),
    recommend("s2", "맛집", "일식"),
    recommend("s3", "카페"),
  ];

  const result = buildCourse(stages, places, 15);

  assert.equal(result.success, true);
  assert.equal(result.stages.length, 3);
  for (const stageResult of result.stages) {
    assert.ok(stageResult.selected !== null);
  }
});

test("최대 이동시간을 넘는 후보는 자동 선택에서 제외되지만, 교체용 후보 목록에는 '초과' 표시로 남아있다", () => {
  const near = place({
    id: "near",
    category: "카페",
    lat: 37.5742,
    lng: 126.9845,
    rating: 3.5,
  });
  const far = place({
    id: "far",
    category: "카페",
    lat: 37.65,
    lng: 126.9845,
    rating: 4.9,
  });
  const start = place({ id: "start", category: "문화 생활" });

  const stages: Stage[] = [
    recommend("s1", "문화 생활"),
    recommend("s2", "카페"),
  ];
  const result = buildCourse(stages, [start, near, far], 15);

  const s2 = result.stages[1];
  assert.ok(s2.kind === "recommend");
  assert.equal(s2.selected?.id, "near");
  const farCandidate = s2.candidates.find((c) => c.place.id === "far");
  assert.ok(farCandidate);
  assert.equal(farCandidate.withinMaxTravel, false);
});

test("selected가 null이어도 previous는 리셋되지 않고 다음 단계는 마지막 장소를 기준으로 계산한다", () => {
  const exhibit = place({ id: "exhibit", category: "문화 생활" });
  const farCafe = place({ id: "far-cafe", category: "카페", lat: 37.65 });
  const nearRestaurant = place({
    id: "near-restaurant",
    category: "맛집",
    lat: 37.5745,
    lng: 126.985,
  });

  const stages: Stage[] = [
    recommend("s1", "문화 생활"),
    recommend("s2", "카페"),
    recommend("s3", "맛집"),
  ];

  const result = buildCourse(stages, [exhibit, farCafe, nearRestaurant], 15);

  assert.equal(result.stages[1].selected, null);
  assert.equal(
    result.stages[2].travelMinutesFromPrevious,
    walkingMinutesBetween(exhibit, nearRestaurant),
  );
});

test("overrides로 지정한 장소는 최대 이동시간을 넘어도 강제로 선택된다", () => {
  const start = place({ id: "start", category: "문화 생활" });
  const near = place({ id: "near", category: "카페", rating: 3.5 });
  const far = place({ id: "far", category: "카페", lat: 37.65, rating: 4.9 });

  const stages: Stage[] = [
    recommend("s1", "문화 생활"),
    recommend("s2", "카페"),
  ];
  const result = buildCourse(stages, [start, near, far], 15, { s2: "far" });

  assert.equal(result.stages[1].selected?.id, "far");
});

test("조건에 맞는 장소가 없으면 success는 false이고 selected는 null이다", () => {
  const onlyCafe = place({ id: "cafe-only", category: "카페" });
  const stages: Stage[] = [recommend("s1", "맛집", "한식")];

  const result = buildCourse(stages, [onlyCafe], 15);

  assert.equal(result.success, false);
  assert.equal(result.stages[0].selected, null);
  assert.ok(result.stages[0].kind === "recommend");
  assert.equal(result.stages[0].candidates.length, 0);
});

test("이미 선택된 장소는 다음 단계 후보에서 제외된다", () => {
  const onlyOption = place({ id: "only", category: "맛집", rating: 4.9 });
  const stages: Stage[] = [recommend("s1", "맛집"), recommend("s2", "맛집")];

  const result = buildCourse(stages, [onlyOption], 15);

  assert.equal(result.stages[0].selected?.id, "only");
  assert.equal(result.stages[1].selected, null);
});

test("코스 시작지만 지정한 경우: 지정 장소는 그대로 들어가고 다음 추천 단계는 그 장소를 기준으로 계산한다", () => {
  const start = designated("start", { lat: 37.5742, lng: 126.9845 });
  const near = place({
    id: "near",
    category: "문화 생활",
    lat: 37.5745,
    lng: 126.985,
  });

  const stages: Stage[] = [start, recommend("s2", "문화 생활")];
  const result = buildCourse(stages, [near], 15);

  assert.equal(result.success, true);
  assert.equal(result.stages[0].selected, start.place);
  assert.equal(result.stages[0].travelMinutesFromPrevious, null);
  assert.equal(result.stages[1].selected?.id, "near");
  assert.ok((result.stages[1].travelMinutesFromPrevious ?? 0) > 0);
});

test("중간에 지정 장소가 있으면, 그 앞 추천 단계는 이전 장소와 지정 장소 양쪽 기준으로 고른다", () => {
  // mid는 전시 후보 바로 옆, far전시는 지정 장소에서 멀리 떨어져 있어 양쪽 조건을 만족 못 한다.
  const start = place({
    id: "start",
    category: "맛집",
    lat: 37.5742,
    lng: 126.9845,
  });
  const midDesignated = designated("mid", { lat: 37.5745, lng: 126.985 });
  const nearExhibit = place({
    id: "near-exhibit",
    category: "문화 생활",
    lat: 37.5744,
    lng: 126.9847,
    rating: 3.6,
  });
  const farExhibit = place({
    id: "far-exhibit",
    category: "문화 생활",
    lat: 37.6,
    lng: 126.9845,
    rating: 4.9,
  });

  const stages: Stage[] = [
    recommend("s1", "맛집"),
    recommend("s2", "문화 생활"),
    midDesignated,
  ];

  const result = buildCourse(stages, [start, nearExhibit, farExhibit], 15);

  assert.equal(result.success, true);
  assert.equal(result.stages[1].selected?.id, "near-exhibit");
});

test("지정 장소끼리 바로 이어진 구간이 최대 이동시간을 넘으면 실패 대신 경고만 표시한다", () => {
  const start = designated("start", { lat: 37.5742, lng: 126.9845 });
  const farDesignated = designated("far", { lat: 37.65, lng: 126.9845 });

  const stages: Stage[] = [start, farDesignated];
  const result = buildCourse(stages, [], 15);

  assert.equal(result.success, true);
  assert.ok(result.stages[1].kind === "designated");
  assert.equal(result.stages[1].travelExceedsMax, true);
  assert.ok((result.stages[1].travelMinutesFromPrevious ?? 0) > 15);
});

test("추천 단계가 다음 지정 장소 때문에 막히면 blockedByDesignated가 true다", () => {
  const start = place({
    id: "start",
    category: "문화 생활",
    lat: 37.5742,
    lng: 126.9845,
  });
  // near는 start와는 가깝지만 지정 장소와는 멀다.
  const near = place({
    id: "near",
    category: "맛집",
    lat: 37.5745,
    lng: 126.985,
  });
  const farDesignated = designated("far", { lat: 37.65, lng: 126.9845 });

  const stages: Stage[] = [
    recommend("s1", "문화 생활"),
    recommend("s2", "맛집"),
    farDesignated,
  ];
  const result = buildCourse(stages, [start, near], 15);

  assert.equal(result.success, false);
  const s2 = result.stages[1];
  assert.ok(s2.kind === "recommend");
  assert.equal(s2.selected, null);
  assert.equal(s2.blockedByDesignated, true);
});

test("isWithinRegionRange: 종로 예시 데이터는 모두 1차 추천 범위 안에 있다", () => {
  for (const p of places) {
    assert.equal(
      isWithinRegionRange(p),
      true,
      `${p.name}이 범위 밖으로 판정됨`,
    );
  }
  assert.equal(isWithinRegionRange({ lat: 37.5, lng: 127.1 }), false);
});

// 2026-11-02는 월요일, 2026-11-03은 화요일이다.
test("일정 날짜가 휴무 요일인 장소는 추천 후보에서 자동 제외된다", () => {
  const closedMonday = place({ id: "closed", rating: 4.9, closedDays: [1] });
  const open = place({ id: "open", rating: 4.0 });
  const stages: Stage[] = [recommend("s1", "맛집")];

  const monday = buildCourse(
    stages,
    [closedMonday, open],
    15,
    {},
    "2026-11-02",
  );
  const s1 = monday.stages[0];
  assert.ok(s1.kind === "recommend");
  assert.equal(s1.selected?.id, "open");
  assert.deepEqual(
    s1.candidates.map((c) => c.place.id),
    ["open"],
  );
  assert.equal(s1.closedExcludedCount, 1);

  const tuesday = buildCourse(
    stages,
    [closedMonday, open],
    15,
    {},
    "2026-11-03",
  );
  const t1 = tuesday.stages[0];
  assert.ok(t1.kind === "recommend");
  assert.equal(t1.selected?.id, "closed");
  assert.equal(t1.closedExcludedCount, 0);
});

test("일정 날짜가 없으면 휴무 요일을 따지지 않는다", () => {
  const closedMonday = place({ id: "closed", rating: 4.9, closedDays: [1] });
  const result = buildCourse([recommend("s1", "맛집")], [closedMonday], 15);
  assert.equal(result.success, true);
  assert.equal(isClosedOn(closedMonday, undefined), false);
  assert.equal(isClosedOn(closedMonday, "형식오류"), false);
});

test("휴무라서 후보가 모두 빠지면 결과 없음이 되고 제외된 수가 남는다", () => {
  const closedMonday = place({ id: "closed", closedDays: [1] });
  const result = buildCourse(
    [recommend("s1", "맛집")],
    [closedMonday],
    15,
    {},
    "2026-11-02",
  );
  assert.equal(result.success, false);
  const s1 = result.stages[0];
  assert.ok(s1.kind === "recommend");
  assert.equal(s1.closedExcludedCount, 1);
});

test("예시 데이터는 모두 운영 시간과 휴무 요일 정보를 갖고 있다", () => {
  for (const p of places) {
    assert.match(p.openTime, /^\d{2}:\d{2}$/, `${p.name} openTime`);
    assert.match(p.closeTime, /^\d{2}:\d{2}$/, `${p.name} closeTime`);
    assert.ok(p.openTime < p.closeTime, `${p.name} 운영 시간 순서`);
    assert.ok(
      p.closedDays.every((d) => d >= 0 && d <= 6),
      `${p.name} closedDays`,
    );
  }
});

test("buildCourse: 평점 정보가 없는 실제 장소(rating 0)도 중간 점수로 추천되고, 중복 id는 하나만 쓴다", () => {
  const live = (id: string, lat: number): Place => ({
    ...place({ id }),
    rating: 0,
    reviewCount: 0,
    lat,
    lng: 127,
    source: "tmap",
  });
  const near = live("tmap-1", 35.0);
  const far = live("tmap-2", 35.006); // 약 13분(10분 구간 밖)
  const result = buildCourse(
    [
      {
        id: "o",
        kind: "designated",
        isOrigin: true,
        place: { id: "p", name: "출발", address: "", lat: 35.0, lng: 127 },
      },
      { id: "s", kind: "recommend", category: near.category },
    ],
    [far, near, near],
    15,
  );
  const stage = result.stages[1];
  assert.equal(stage.kind, "recommend");
  if (stage.kind === "recommend") {
    assert.equal(stage.selected?.id, "tmap-1");
    assert.equal(stage.candidates.length, 2);
  }
});

test("a stage with search keywords only uses places fetched with those keywords", () => {
  const stage: RecommendStage = {
    id: "s1",
    kind: "recommend",
    category: "카페",
    keywords: ["북카페"],
  };
  const generic = place({ id: "generic", category: "카페" });
  const tagged = place({
    id: "tagged",
    category: "카페",
    keywordKey: "북카페",
  });
  const other = place({
    id: "other",
    category: "카페",
    keywordKey: "루프탑카페",
  });
  const result = buildCourse([stage], [generic, other, tagged], 15);
  const first = result.stages[0];
  assert.equal(first.kind, "recommend");
  assert.equal(first.selected?.id, "tagged");
});

test("거리 보너스는 10분 단위 구간으로 차등: 0~10분은 모두 같고 구간이 멀어질수록 줄어든다", () => {
  assert.equal(proximityBonus(null, 30), 0);
  assert.equal(proximityBonus(0, 30), proximityBonus(10, 30));
  assert.equal(proximityBonus(3, 30), proximityBonus(9.9, 30));
  assert.ok(proximityBonus(10.1, 30) < proximityBonus(10, 30));
  assert.ok(proximityBonus(20.1, 30) < proximityBonus(19, 30));
  assert.equal(proximityBonus(19, 30), proximityBonus(11, 30));
  // 한도가 5분이면 구간이 하나라서 모두 같다.
  assert.equal(proximityBonus(1, 5), proximityBonus(5, 5));
  // 한도를 넘어도 음수는 되지 않는다.
  assert.ok(proximityBonus(80, 30) >= 0);
});

test("리뷰 수 보너스는 0~99 / 100~999 / 1000~ 구간별로 같은 폭씩 오르고 구간 안에서는 동일하다", () => {
  assert.equal(reviewBonus(0), 0);
  assert.equal(reviewBonus(0), reviewBonus(99));
  assert.equal(reviewBonus(100), reviewBonus(999));
  assert.equal(reviewBonus(1000), reviewBonus(50000));
  const step1 = reviewBonus(100) - reviewBonus(99);
  const step2 = reviewBonus(1000) - reviewBonus(999);
  assert.ok(step1 > 0);
  assert.ok(Math.abs(step1 - step2) < 1e-9);
});

test("내 출발지(startPoint)는 첫 장소의 이동 기준점이다: 최대 이동시간 밖 후보는 제외하고, 이동시간 합계에는 넣지 않는다", () => {
  const near = place({ id: "near", rating: 4.0, lat: 37.5742, lng: 126.9845 });
  // 약 0.02도(≈2.2km) 떨어진 곳이라 15분 안에 못 간다.
  const far = place({ id: "far", rating: 4.9, lat: 37.5942, lng: 126.9845 });
  const start = { lat: 37.5742, lng: 126.9845 };

  const withoutStart = buildCourse([recommend("a", "맛집")], [near, far], 15);
  // 기준점이 없으면 거리 제한이 없어 평점이 높은 쪽이 뽑힌다.
  assert.equal(withoutStart.stages[0].selected?.id, "far");

  const result = buildCourse(
    [recommend("a", "맛집")],
    [near, far],
    15,
    {},
    undefined,
    start,
  );
  const first = result.stages[0];
  assert.equal(first.kind, "recommend");
  assert.equal(first.selected?.id, "near");
  // 코스에 들어가는 장소가 아니므로 첫 장소의 이동시간은 비어 있고 합계도 0이다.
  assert.equal(first.travelMinutesFromPrevious, null);
  assert.equal(result.totalTravelMinutes, 0);
});
