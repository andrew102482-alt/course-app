import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCourse,
  straightLineDistanceMeters,
  walkingMinutesBetween,
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
    ...overrides,
  };
}

test("같은 지점의 거리와 이동시간은 0이다", () => {
  const a = place({ id: "a" });
  assert.equal(straightLineDistanceMeters(a, a), 0);
  assert.equal(walkingMinutesBetween(a, a), 0);
});

test("약 110m 떨어진 두 지점의 도보 시간은 1.3배 가산된 값과 같다", () => {
  const a = place({ id: "a", lat: 37.5742, lng: 126.9845 });
  const b = place({ id: "b", lat: 37.5752, lng: 126.9845 }); // 위도 0.001 차이 ≈ 111m
  const distance = straightLineDistanceMeters(a, b);
  const expectedMinutes = (distance * 1.3) / 67;

  assert.ok(Math.abs(distance - 111) < 5);
  assert.equal(walkingMinutesBetween(a, b), expectedMinutes);
});

test("'전시 → 맛집(일식) → 카페' 코스는 15분 기준으로 3곳을 모두 추천한다", () => {
  const stages: Stage[] = [
    { id: "s1", category: "전시" },
    { id: "s2", category: "맛집", subCategory: "일식" },
    { id: "s3", category: "카페" },
  ];

  const result = buildCourse(stages, places, 15);

  assert.equal(result.success, true);
  assert.equal(result.stages.length, 3);
  assert.equal(result.stages[1].selected?.subCategory, "일식");
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
    lat: 37.65, // 약 8km 떨어진 먼 지점
    lng: 126.9845,
    rating: 4.9,
  });
  const start = place({ id: "start", category: "전시" });

  const stages: Stage[] = [
    { id: "s1", category: "전시" },
    { id: "s2", category: "카페" },
  ];

  const result = buildCourse(stages, [start, near, far], 15);

  assert.equal(result.stages[1].selected?.id, "near");

  const farCandidate = result.stages[1].candidates.find(
    (c) => c.place.id === "far",
  );
  assert.ok(farCandidate);
  assert.equal(farCandidate.withinMaxTravel, false);
});

test("selected가 null이어도 previous는 리셋되지 않고 다음 단계는 마지막 장소를 기준으로 계산한다", () => {
  const exhibit = place({ id: "exhibit", category: "전시" });
  const farCafe = place({
    id: "far-cafe",
    category: "카페",
    lat: 37.65,
  });
  const nearRestaurant = place({
    id: "near-restaurant",
    category: "맛집",
    lat: 37.5745,
    lng: 126.985,
  });

  // 2단계(카페)는 15분 이내 후보가 없어 selected가 null이 된다.
  const stages: Stage[] = [
    { id: "s1", category: "전시" },
    { id: "s2", category: "카페" },
    { id: "s3", category: "맛집" },
  ];

  const result = buildCourse(
    stages,
    [exhibit, farCafe, nearRestaurant],
    15,
  );

  assert.equal(result.stages[1].selected, null);
  // 3단계는 2단계(null)가 아니라 1단계(exhibit)를 기준으로 거리가 계산돼야 한다.
  assert.equal(
    result.stages[2].travelMinutesFromPrevious,
    walkingMinutesBetween(exhibit, nearRestaurant),
  );
});

test("overrides로 지정한 장소는 최대 이동시간을 넘어도 강제로 선택된다", () => {
  const start = place({ id: "start", category: "전시" });
  const near = place({ id: "near", category: "카페", rating: 3.5 });
  const far = place({
    id: "far",
    category: "카페",
    lat: 37.65,
    rating: 4.9,
  });

  const stages: Stage[] = [
    { id: "s1", category: "전시" },
    { id: "s2", category: "카페" },
  ];

  const result = buildCourse(stages, [start, near, far], 15, { s2: "far" });

  assert.equal(result.stages[1].selected?.id, "far");
});

test("조건에 맞는 장소가 없으면 success는 false이고 selected는 null이다", () => {
  const onlyCafe = place({ id: "cafe-only", category: "카페" });
  const stages: Stage[] = [{ id: "s1", category: "맛집", subCategory: "한식" }];

  const result = buildCourse(stages, [onlyCafe], 15);

  assert.equal(result.success, false);
  assert.equal(result.stages[0].selected, null);
  assert.equal(result.stages[0].candidates.length, 0);
});

test("이미 선택된 장소는 다음 단계 후보에서 제외된다", () => {
  const onlyOption = place({ id: "only", category: "맛집", rating: 4.9 });
  const stages: Stage[] = [
    { id: "s1", category: "맛집" },
    { id: "s2", category: "맛집" },
  ];

  const result = buildCourse(stages, [onlyOption], 15);

  assert.equal(result.stages[0].selected?.id, "only");
  assert.equal(result.stages[1].selected, null);
});
