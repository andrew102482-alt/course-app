import type { Place, PlaceCategory } from "../data/places.ts";
import {
  buildCourse,
  keywordKeyOf,
  type Stage,
  type StageOverrides,
} from "./course.ts";
import type { Region } from "./regions.ts";

/**
 * 예시 데이터(종로) 밖의 추천 후보. 서버 통로(/api/places/nearby, TMAP 장소 검색)에서
 * "기준 지점 주변 × 카테고리"마다 한 번 가져와 기억해 둔다. 평점·영업시간은 받을 수 없어 비어 있다.
 * 기준 지점은 첫 장소는 출발 지역, 그다음부터는 직전에 고른 장소다(그래서 코스가 출발 지역 밖으로 이어질 수 있다).
 */
const SAMPLE_REGION_ID = "jongno";
const cache = new Map<string, Place[]>();
const inflight = new Map<string, Promise<void>>();
const GRID = 0.005; // 약 550m. 비슷한 기준 지점은 같은 검색 결과를 같이 쓴다.
const METERS_PER_MINUTE = 67;
const DETOUR = 1.3;

let version = 0;
const listeners = new Set<() => void>();
export function subscribeLivePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function livePlacesVersion(): number {
  return version;
}
function markChanged() {
  version++;
  listeners.forEach((l) => l());
}
/** 지금 장소를 가져오는 중이면 true. */
export function isLoadingLive(): boolean {
  return inflight.size > 0;
}

type Point = { lat: number; lng: number };
type Anchor = Point & { radius: number };
type ApiPlace = {
  id: string;
  name: string;
  category: PlaceCategory;
  subCategory?: string;
  bizName: string;
  region: string;
  lat: number;
  lng: number;
};

function keyOf(a: Point, category: string, sub?: string, kw?: string[]) {
  return `${Math.round(a.lat / GRID)},${Math.round(a.lng / GRID)}|${category}|${sub ?? ""}|${kw ? keywordKeyOf(kw) : ""}`;
}

function toPlace(p: ApiPlace, keywordKey?: string): Place {
  return {
    ...(keywordKey ? { keywordKey } : {}),
    id: p.id,
    name: p.name,
    region: p.region,
    category: p.category,
    subCategory: p.subCategory,
    lat: p.lat,
    lng: p.lng,
    rating: 0,
    reviewCount: 0,
    description: [p.bizName, p.region].filter(Boolean).join(" · "),
    openTime: "",
    closeTime: "",
    closedDays: [],
    source: "tmap",
    address: p.region,
  };
}

function fetchOne(a: Anchor, category: string, sub?: string, kw?: string[]) {
  const key = keyOf(a, category, sub, kw);
  if (cache.has(key)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const params = new URLSearchParams({
    lat: String(a.lat),
    lng: String(a.lng),
    r: String(Math.round(a.radius)),
    category,
  });
  if (sub) params.set("sub", sub);
  if (kw && kw.length > 0) params.set("kw", kw.join(","));
  const job = fetch(`/api/places/nearby?${params}`)
    .then((r) => (r.ok ? r.json() : { results: [] }))
    .then((d: { results?: ApiPlace[] }) => {
      cache.set(
        key,
        (d.results ?? []).map((r) =>
          toPlace(r, kw && kw.length > 0 ? keywordKeyOf(kw) : undefined),
        ),
      );
    })
    .catch(() => {
      cache.set(key, []);
    })
    .finally(() => {
      inflight.delete(key);
      markChanged();
    });
  inflight.set(key, job);
  markChanged();
  return job;
}

/** 지금까지 가져온 실제 장소 후보(같은 장소·같은 세부 카테고리는 하나만). */
export function getLivePlaces(): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const list of cache.values()) {
    for (const p of list) {
      const k = `${p.id}|${p.category}|${p.subCategory ?? ""}|${p.keywordKey ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

export function includesSampleRegion(regions: Region[]): boolean {
  return regions.some((r) => r.id === SAMPLE_REGION_ID);
}

/**
 * 이 일정의 추천 단계마다 "기준 지점 주변" 후보를 가져온다.
 * 기준 지점은 직전 장소라서, 장소를 하나 정할 때마다 다음 단계 후보를 더 가져와야 한다.
 * 그래서 코스를 계산 → 필요한 후보를 가져옴 → 다시 계산을 더 가져올 게 없을 때까지 되풀이한다.
 */
export async function loadLivePlacesForCourse(opts: {
  stages: Stage[]; // 장소를 안 정한("상관없음") 칸은 뺀 일정
  starts: Region[];
  maxTravelMinutes: number;
  overrides: StageOverrides;
  planDate?: string;
  samples: Place[];
}): Promise<void> {
  const { stages, starts, maxTravelMinutes, overrides, planDate, samples } =
    opts;
  if (!stages.some((s) => s.kind === "recommend")) return;
  const walkRadius = Math.min(
    3500,
    Math.max(
      1000,
      ((maxTravelMinutes * METERS_PER_MINUTE) / DETOUR) * 1.15 + 600,
    ),
  );

  for (let pass = 0; pass <= stages.length + 1; pass++) {
    const result = buildCourse(
      stages,
      [...samples, ...getLivePlaces()],
      maxTravelMinutes,
      overrides,
      planDate,
    );
    const jobs: Promise<void>[] = [];
    let previous: Point | null = null;
    for (const r of result.stages) {
      if (r.kind === "recommend") {
        const anchors: Anchor[] = previous
          ? [{ ...previous, radius: walkRadius }]
          : starts.map((s) => ({
              lat: s.lat,
              lng: s.lng,
              radius: Math.max(s.radius, walkRadius),
            }));
        for (const a of anchors) {
          const { category, subCategory, keywords } = r.stage;
          const k = keyOf(a, category, subCategory, keywords);
          if (!cache.has(k))
            jobs.push(fetchOne(a, category, subCategory, keywords));
        }
      }
      if (r.selected) previous = r.selected;
    }
    if (jobs.length === 0) return;
    await Promise.all(jobs);
  }
}
