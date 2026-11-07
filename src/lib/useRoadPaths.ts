"use client";

import { useEffect, useState } from "react";
import type { LatLng } from "@/components/NaverMapCanvas";

export type RoadLeg = { path: LatLng[]; minutes: number | null };

// 같은 구간은 한 번만 서버에 묻는다. null = 길을 못 받아 직선으로 대신함.
const cache = new Map<string, RoadLeg | null>();

function keyOf(a: LatLng, b: LatLng): string {
  return `${a.lng.toFixed(4)},${a.lat.toFixed(4)}|${b.lng.toFixed(4)},${b.lat.toFixed(4)}`;
}

/** 각 구간(from → to)의 도보 경로선과 소요 시간을 받아온다. 받기 전·실패 시에는 해당 칸이 없다(직선으로 그리면 된다). */
export function useRoadPaths(
  legs: { from: LatLng; to: LatLng }[],
  enabled: boolean,
): (RoadLeg | null)[] {
  const keys = legs.map((l) => keyOf(l.from, l.to));
  const signature = keys.join(";");
  const [, bump] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
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
          }) => {
            if (data.path) {
              cache.set(key, {
                path: data.path.map(([lat, lng]) => ({ lat, lng })),
                minutes: data.minutes ?? null,
              });
              if (alive) bump((n) => n + 1);
            }
          },
        );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  return keys.map((k) => cache.get(k) ?? null);
}
