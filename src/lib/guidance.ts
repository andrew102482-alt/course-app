import {
  METERS_PER_MINUTE_WALKING,
  straightLineDistanceMeters,
} from "./course.ts";

type LatLng = { lat: number; lng: number };
export type GuideStep = LatLng & { text: string; turn: number };

/** 경로선 위에서 내 위치와 가장 가까운 점의 번호와, 그 점까지 떨어진 거리(m). */
export function nearestOnPath(
  path: LatLng[],
  me: LatLng,
): { index: number; offMeters: number } {
  let best = 0;
  let bestDist = Infinity;
  path.forEach((p, i) => {
    const d = straightLineDistanceMeters(p, me);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return { index: best, offMeters: bestDist };
}

/** 경로선의 from번 점부터 to번 점까지 이어 붙인 길이(m). */
export function pathDistance(path: LatLng[], from: number, to: number): number {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(to, path.length - 1); i++) {
    sum += straightLineDistanceMeters(path[i], path[i + 1]);
  }
  return sum;
}

export type Progress = {
  /** 도착(코스 시작지)까지 남은 거리(m). */
  remainingMeters: number;
  /** 도착까지 남은 시간(분). 총 시간을 알면 남은 비율로, 모르면 분당 67m로 계산. */
  remainingMinutes: number;
  /** 다음에 따라야 할 안내(없으면 곧 도착). */
  next: { step: GuideStep; meters: number } | null;
  arrived: boolean;
  /** 경로에서 많이 벗어났는지(다시 길을 찾아야 하는 정도). */
  offRoute: boolean;
};

const ARRIVE_METERS = 25;
const OFF_ROUTE_METERS = 80;

export function computeProgress(
  path: LatLng[],
  steps: GuideStep[],
  me: LatLng,
  totalMinutes: number | null,
): Progress {
  const { index, offMeters } = nearestOnPath(path, me);
  const remainingMeters = Math.round(
    offMeters + pathDistance(path, index, path.length - 1),
  );
  const total = pathDistance(path, 0, path.length - 1);
  const remainingMinutes =
    totalMinutes !== null && total > 0
      ? totalMinutes * Math.min(1, remainingMeters / total)
      : remainingMeters / METERS_PER_MINUTE_WALKING;

  // 각 안내 지점이 경로선의 몇 번째 점인지 찾아, 내 앞쪽에 있는 첫 안내를 고른다.
  // (맨 앞 "출발" 안내와 마지막 "도착" 안내는 제외하고, 도착 가까우면 도착으로 본다.)
  const arrived = remainingMeters <= ARRIVE_METERS;
  let next: Progress["next"] = null;
  if (!arrived) {
    for (const step of steps) {
      if (step.turn === 200) continue; // 출발
      const stepIndex = nearestOnPath(path, step).index;
      if (stepIndex > index || (stepIndex === index && step.turn !== 201)) {
        const meters = Math.round(
          straightLineDistanceMeters(me, step) > 0
            ? offMeters + pathDistance(path, index, stepIndex)
            : 0,
        );
        next = { step, meters };
        break;
      }
    }
  }
  return {
    remainingMeters,
    remainingMinutes,
    next,
    arrived,
    offRoute: offMeters > OFF_ROUTE_METERS,
  };
}

/** TMAP 안내 종류(turnType)에 맞는 아이콘. */
export function turnIcon(turn: number): string {
  if ([12, 16, 17].includes(turn)) return "⬅️";
  if ([13, 18, 19].includes(turn)) return "➡️";
  if (turn === 14) return "↩️";
  if (turn === 201) return "📍";
  if (turn >= 211 && turn <= 217) return "🚸";
  if ([125, 126, 127, 128, 129, 218].includes(turn)) return "🪜";
  return "⬆️";
}

/** 거리를 "120m" / "1.2km"로. */
export function formatMeters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
