type LatLng = { lat: number; lng: number };

const M_PER_DEG_LAT = 111320;

function toXY(p: LatLng, refLat: number) {
  return {
    x: p.lng * M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180),
    y: p.lat * M_PER_DEG_LAT,
  };
}

/** 점 p에서 선분 a-b까지의 거리(m). */
function distToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const r = p.lat;
  const P = toXY(p, r);
  const A = toXY(a, r);
  const B = toXY(b, r);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

/** 선을 진행 방향의 오른쪽으로 meters만큼 옮긴 새 선(음수면 왼쪽). */
export function offsetPath(path: LatLng[], meters: number): LatLng[] {
  if (meters === 0 || path.length < 2) return path;
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const A = toXY(a, p.lat);
    const B = toXY(b, p.lat);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return p;
    // 오른쪽 법선 = (dy, -dx) / len (동쪽, 북쪽 방향 미터)
    const east = (dy / len) * meters;
    const north = (-dx / len) * meters;
    return {
      lat: p.lat + north / M_PER_DEG_LAT,
      lng: p.lng + east / (M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180)),
    };
  });
}

/** 선 line의 점들 중 other 선 가까이(thresholdMeters 안)에 있는 비율. */
export function overlapRatio(
  line: LatLng[],
  other: LatLng[],
  thresholdMeters: number,
): number {
  if (line.length === 0 || other.length < 2) return 0;
  let near = 0;
  for (const p of line) {
    for (let i = 0; i < other.length - 1; i++) {
      if (distToSegment(p, other[i], other[i + 1]) <= thresholdMeters) {
        near++;
        break;
      }
    }
  }
  return near / line.length;
}

/**
 * 같은 길 위에 겹쳐 그려지는 선들을 조금씩 옆으로 벌린다.
 * 먼저 온 선은 그대로 두고, 앞선 선들과 겹치는 선은 겹치는 개수만큼 오른쪽으로 gapMeters씩 옮긴다.
 */
export function separateOverlaps<T extends { path: LatLng[] }>(
  lines: T[],
  gapMeters = 12,
): T[] {
  const result: T[] = [];
  lines.forEach((line, i) => {
    let lane = 0;
    for (let j = 0; j < i; j++) {
      if (overlapRatio(line.path, lines[j].path, 10) >= 0.3) lane++;
    }
    result.push(
      lane === 0
        ? line
        : { ...line, path: offsetPath(line.path, lane * gapMeters) },
    );
  });
  return result;
}
