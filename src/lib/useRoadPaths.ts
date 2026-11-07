"use client";

import { useEffect, useState } from "react";
import type { LatLng } from "@/components/NaverMapCanvas";

export type RoadStep = LatLng & { text: string; turn: number };
export type RoadLeg = {
  path: LatLng[];
  minutes: number | null;
  meters: number | null;
  steps: RoadStep[];
};

// 같은 구간은 한 번만 서버에 묻는다. null = 길을 못 받아 직선으로 대신함.
const cache = new Map<string, RoadLeg | null>();
// 같은 구간을 쓰는 여러 화면(지도·안내 패널)이 함께 다시 그려지도록 알린다.
const subscribers = new Set<() => void>();

// coarse: 걸어 다니는 내 위치처럼 계속 바뀌는 시작점은 약 100m 단위로 묶어서, 조금 움직일 때마다 새로 묻지 않게 한다.
function keyOf(a: LatLng, b: LatLng, coarse: boolean): string {
  const d = coarse ? 3 : 4;
  return `${a.lng.toFixed(d)},${a.lat.toFixed(d)}|${b.lng.toFixed(4)},${b.lat.toFixed(4)}`;
}

/** 각 구간(from → to)의 도보 경로선과 소요 시간을 받아온다. 받기 전·실패 시에는 해당 칸이 없다(직선으로 그리면 된다). */
export function useRoadPaths(
  legs: { from: LatLng; to: LatLng; coarse?: boolean }[],
  enabled: boolean,
): (RoadLeg | null)[] {
  const keys = legs.map((l) => keyOf(l.from, l.to, !!l.coarse));
  const signature = keys.join(";");
  const [, bump] = useState(0);

  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    subscribers.add(notify);
    return () => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    legs.forEach((leg, i) => {
      const key = keys[i];
      if (cache.has(key)) return;
      cache.set(key, null);
      fetch(
        `/api/maps/directions?start=${leg.from.lng},${leg.from.lat}&goal=${leg.to.lng},${leg.to.lat}`,
      )
        .then((r) => (r.ok ? r.json() : { path: null }))
        .catch(() => ({ path: null }))
        .then(
          (data: {
            path: [number, number][] | null;
            minutes?: number | null;
            meters?: number | null;
            steps?: RoadStep[];
          }) => {
            if (data.path) {
              cache.set(key, {
                path: data.path.map(([lat, lng]) => ({ lat, lng })),
                minutes: data.minutes ?? null,
                meters: data.meters ?? null,
                steps: data.steps ?? [],
              });
              subscribers.forEach((notify) => notify());
            }
          },
        );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  return keys.map((k) => cache.get(k) ?? null);
}
