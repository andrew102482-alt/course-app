import test from "node:test";
import assert from "node:assert/strict";
import { offsetPath, overlapRatio, separateOverlaps } from "./lineOffset.ts";
import { straightLineDistanceMeters } from "./course.ts";

// 북쪽으로 곧게 뻗은 길 (약 330m)
const north = [0, 1, 2, 3].map((i) => ({ lat: 37.5 + i * 0.001, lng: 127 }));

test("북쪽으로 가는 선을 오른쪽(동쪽)으로 옮긴다", () => {
  const moved = offsetPath(north, 12);
  assert.ok(moved[1].lng > north[1].lng);
  assert.ok(Math.abs(moved[1].lat - north[1].lat) < 1e-9);
  const d = straightLineDistanceMeters(moved[1], north[1]);
  assert.ok(Math.abs(d - 12) < 0.5);
});

test("같은 길이면 겹침 비율이 1, 멀리 떨어진 선은 0", () => {
  assert.equal(overlapRatio(north, north, 10), 1);
  const far = north.map((p) => ({ ...p, lng: p.lng + 0.01 }));
  assert.equal(overlapRatio(far, north, 10), 0);
});

test("겹치는 선만 벌리고 안 겹치는 선은 그대로 둔다", () => {
  const far = north.map((p) => ({ ...p, lng: p.lng + 0.01 }));
  const out = separateOverlaps([
    { id: "a", path: north },
    { id: "b", path: north },
    { id: "c", path: far },
  ]);
  assert.deepEqual(out[0].path, north);
  assert.notDeepEqual(out[1].path, north);
  assert.deepEqual(out[2].path, far);
  assert.ok(overlapRatio(out[1].path, north, 10) < 1);
});
