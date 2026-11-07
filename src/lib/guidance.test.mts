import test from "node:test";
import assert from "node:assert/strict";
import {
  computeProgress,
  formatMeters,
  nearestOnPath,
  turnIcon,
} from "./guidance.ts";

// 위도 0.001도 ≈ 111m. 북쪽으로 곧게 뻗은 길 (0 → 0.004도 ≈ 445m)
const path = [0, 1, 2, 3, 4].map((i) => ({ lat: 37.5 + i * 0.001, lng: 127 }));
const steps = [
  { ...path[0], text: "출발", turn: 200 },
  { ...path[2], text: "좌회전", turn: 12 },
  { ...path[4], text: "도착", turn: 201 },
];

test("가장 가까운 경로 점을 찾는다", () => {
  const r = nearestOnPath(path, { lat: 37.5021, lng: 127 });
  assert.equal(r.index, 2);
});

test("출발 직후에는 다음 안내가 좌회전이고 남은 거리가 총 길이쯤이다", () => {
  const p = computeProgress(path, steps, path[0], 6);
  assert.equal(p.arrived, false);
  assert.equal(p.next?.step.text, "좌회전");
  assert.ok(Math.abs(p.remainingMeters - 445) < 15);
  assert.ok(p.remainingMinutes > 5.5 && p.remainingMinutes <= 6);
});

test("좌회전 지점을 지나면 다음 안내는 도착이다", () => {
  const p = computeProgress(path, steps, { lat: 37.5031, lng: 127 }, 6);
  assert.equal(p.next?.step.text, "도착");
});

test("도착 지점 근처면 도착으로 본다", () => {
  const p = computeProgress(path, steps, { lat: 37.50395, lng: 127 }, 6);
  assert.equal(p.arrived, true);
  assert.equal(p.next, null);
});

test("경로에서 멀리 벗어나면 offRoute", () => {
  const p = computeProgress(path, steps, { lat: 37.502, lng: 127.005 }, 6);
  assert.equal(p.offRoute, true);
});

test("표시 형식", () => {
  assert.equal(formatMeters(120), "120m");
  assert.equal(formatMeters(1234), "1.2km");
  assert.equal(turnIcon(12), "⬅️");
  assert.equal(turnIcon(13), "➡️");
  assert.equal(turnIcon(201), "📍");
});
