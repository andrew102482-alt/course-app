import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REGION,
  MAX_REGIONS,
  REGIONS,
  isWithinRegions,
  regionsLabel,
  resolveRegions,
} from "./regions.ts";
import { keywordsFor } from "./liveSearch.ts";

test("resolveRegions: 알 수 없는 id는 버리고, 비면 종로", () => {
  assert.deepEqual(resolveRegions(["nope"]), [DEFAULT_REGION]);
  assert.deepEqual(resolveRegions(undefined), [DEFAULT_REGION]);
  assert.deepEqual(
    resolveRegions(["hongdae", "nope", "hongdae"]).map((r) => r.id),
    ["hongdae"],
  );
});

test("resolveRegions: 최대 개수까지만", () => {
  const ids = REGIONS.slice(0, MAX_REGIONS + 2).map((r) => r.id);
  assert.equal(resolveRegions(ids).length, MAX_REGIONS);
});

test("isWithinRegions: 고른 지역 반경 안/밖", () => {
  const haeundae = resolveRegions(["busan-haeundae"]);
  assert.equal(
    isWithinRegions({ lat: 35.1631, lng: 129.1639 }, haeundae),
    true,
  );
  assert.equal(
    isWithinRegions({ lat: 37.5759, lng: 126.9825 }, haeundae),
    false,
  );
  const both = resolveRegions(["busan-haeundae", "jongno"]);
  assert.equal(isWithinRegions({ lat: 37.5759, lng: 126.9825 }, both), true);
});

test("regionsLabel: 길면 줄인다", () => {
  const r = resolveRegions(["jongno", "hongdae", "seongsu"]);
  assert.equal(regionsLabel(r.slice(0, 2)), "종로 · 홍대·합정");
  assert.equal(regionsLabel(r), "종로 외 2곳");
});

test("keywordsFor: 세부 카테고리별 검색어, 없으면 대분류 기본값", () => {
  assert.ok(keywordsFor("카페", "디저트").includes("디저트카페"));
  assert.ok(keywordsFor("카페").length > 0);
  assert.ok(keywordsFor("쇼핑", "없는세부").length > 0);
});
