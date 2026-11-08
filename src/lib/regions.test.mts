import test from "node:test";
import assert from "node:assert/strict";
import {
  AREAS,
  DEFAULT_SELECTION,
  DONGS,
  dongsOf,
  parseRegionAddress,
  regionLabel,
  resolveSelection,
  selectionRegions,
} from "./regions.ts";
import { keywordsFor } from "./liveSearch.ts";

test("resolveSelection: 모르는 값은 서울·종로, 예전 형식(id 목록)도 읽는다", () => {
  assert.deepEqual(resolveSelection(undefined), DEFAULT_SELECTION);
  assert.deepEqual(resolveSelection({ areaId: "nope" }), DEFAULT_SELECTION);
  assert.deepEqual(resolveSelection(["busan-haeundae", "jongno"]), {
    areaId: "busan",
    dongId: "busan-haeundae",
  });
});

test("resolveSelection: 시·도만 골라도(동 없이) 된다", () => {
  assert.deepEqual(resolveSelection({ areaId: "jeju", dongId: null }), {
    areaId: "jeju",
    dongId: null,
  });
});

test("selectionRegions: 동을 고르면 그 동, 없으면 시·도 대표 중심", () => {
  const dong = selectionRegions({ areaId: "busan", dongId: "busan-haeundae" });
  assert.equal(dong.length, 1);
  assert.equal(dong[0].name, "해운대");
  const area = selectionRegions({ areaId: "busan", dongId: null });
  assert.equal(area[0].name, "부산");
  // 다른 시·도의 동을 넘기면 시·도 중심으로 대신한다.
  assert.equal(
    selectionRegions({ areaId: "seoul", dongId: "busan-haeundae" })[0].name,
    "서울",
  );
});

test("regionLabel: 동은 '시·도 · 동', 시·도만이면 시·도", () => {
  assert.equal(
    regionLabel(selectionRegions({ areaId: "seoul", dongId: "jongno" })[0]),
    "서울 · 종로",
  );
  assert.equal(
    regionLabel(selectionRegions({ areaId: "seoul", dongId: null })[0]),
    "서울",
  );
});

test("모든 시·도에 동이 있고, 동 id는 겹치지 않는다", () => {
  for (const a of AREAS) assert.ok(dongsOf(a.id).length > 0, a.name);
  assert.equal(new Set(DONGS.map((d) => d.id)).size, DONGS.length);
});

test("keywordsFor: 세부 카테고리별 검색어, 없으면 대분류 기본값", () => {
  assert.ok(keywordsFor("카페", "디저트").includes("디저트카페"));
  assert.ok(keywordsFor("카페").length > 0);
  assert.ok(keywordsFor("쇼핑", "없는세부").length > 0);
});

test("parseRegionAddress: 주소에서 시·도와 구·동 이름만 뽑는다", () => {
  assert.deepEqual(parseRegionAddress("서울특별시 성북구 안암동"), {
    areaId: "seoul",
    name: "성북구 안암동",
  });
  assert.deepEqual(parseRegionAddress("부산광역시 해운대구"), {
    areaId: "busan",
    name: "해운대구",
  });
  assert.deepEqual(parseRegionAddress("경기도 수원시 팔달구 인계동 1-1"), {
    areaId: "gyeonggi",
    name: "수원시 팔달구 인계동",
  });
  assert.deepEqual(parseRegionAddress("충청남도 천안시 동남구"), {
    areaId: "chungcheong",
    name: "천안시 동남구",
  });
  assert.equal(parseRegionAddress("서울특별시"), null);
  assert.equal(parseRegionAddress("모르는도 어딘가동"), null);
});

test("검색으로 고른 구·동(custom)은 저장·복원되고 출발 지역이 된다", () => {
  const sel = {
    areaId: "seoul",
    dongId: null,
    custom: { name: "성북구 안암동", lat: 37.58585, lng: 127.021329 },
  };
  assert.deepEqual(resolveSelection(JSON.parse(JSON.stringify(sel))), sel);
  const [region] = selectionRegions(sel);
  assert.equal(region.lat, 37.58585);
  assert.equal(region.radius, 1500); // 동은 좁게
  assert.equal(regionLabel(region), "서울 · 성북구 안암동");
  const gu = selectionRegions({
    areaId: "seoul",
    dongId: null,
    custom: { name: "성북구", lat: 37.5894, lng: 127.0167 },
  })[0];
  assert.equal(gu.radius, 3000); // 구는 넓게
  // 좌표가 한국 밖이면 버리고 시·도만 쓴다.
  assert.deepEqual(
    resolveSelection({
      areaId: "seoul",
      custom: { name: "이상한곳", lat: 0, lng: 0 },
    }),
    { areaId: "seoul", dongId: null },
  );
});
