import test from "node:test";
import assert from "node:assert/strict";
import {
  AREAS,
  DEFAULT_SELECTION,
  DONGS,
  dongsOf,
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
