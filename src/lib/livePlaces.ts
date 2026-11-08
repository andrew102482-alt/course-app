import type { Place, PlaceCategory } from "../data/places.ts";
import type { Region } from "./regions.ts";
import type { Stage } from "./course.ts";

/**
 * 예시 데이터(종로)가 없는 지역의 추천 후보. 지역 × 카테고리마다 서버 통로(/api/places/nearby,
 * TMAP 장소 검색)에서 한 번 가져와 기억해 둔다. 평점·영업시간은 받을 수 없어 비어 있다.
 */
const SAMPLE_REGION_ID = "jongno";
const cache = new Map<string, Place[]>();
const inflight = new Map<string, Promise<void>>();

// 후보를 새로 가져올 때마다 올라가는 번호. 화면이 구독해서 코스를 다시 계산한다.
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

function keyOf(region: Region, category: string, sub?: string) {
  return `${region.id}|${category}|${sub ?? ""}`;
}

function toPlace(p: ApiPlace): Place {
  return {
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

function fetchOne(region: Region, category: string, sub?: string) {
  const key = keyOf(region, category, sub);
  if (cache.has(key)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const params = new URLSearchParams({
    lat: String(region.lat),
    lng: String(region.lng),
    r: String(region.radius),
    category,
  });
  if (sub) params.set("sub", sub);
  const job = fetch(`/api/places/nearby?${params}`)
    .then((r) => (r.ok ? r.json() : { results: [] }))
    .then((d: { results?: ApiPlace[] }) => {
      cache.set(key, (d.results ?? []).map(toPlace));
      markChanged();
    })
    .catch(() => {
      cache.set(key, []);
      markChanged();
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** 이 일정에 필요한 (지역, 카테고리) 후보를 모두 가져온다. 새로 가져온 게 있으면 true. */
export async function loadLivePlaces(
  regions: Region[],
  stages: Stage[],
): Promise<boolean> {
  const jobs: Promise<void>[] = [];
  let fresh = false;
  for (const region of regions) {
    if (region.id === SAMPLE_REGION_ID) continue;
    const seen = new Set<string>();
    for (const s of stages) {
      if (s.kind !== "recommend") continue;
      const k = keyOf(region, s.category, s.subCategory);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!cache.has(k)) fresh = true;
      jobs.push(fetchOne(region, s.category, s.subCategory));
    }
  }
  await Promise.all(jobs);
  return fresh;
}

function distance(a: { lat: number; lng: number }, b: Region): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** 지금까지 가져온 실제 장소 후보(지역 반경 안, 중복 제거). */
export function getLivePlaces(regions: Region[]): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    if (region.id === SAMPLE_REGION_ID) continue;
    for (const [key, list] of cache) {
      if (!key.startsWith(`${region.id}|`)) continue;
      for (const p of list) {
        // 같은 장소가 다른 세부 카테고리 검색에서 또 나오면 처음 것만 쓴다.
        const dedupeKey = `${p.id}|${p.category}|${p.subCategory ?? ""}`;
        if (seen.has(dedupeKey) || distance(p, region) > region.radius * 1.3)
          continue;
        seen.add(dedupeKey);
        out.push(p);
      }
    }
  }
  return out;
}

/** 이 일정에 쓸 후보 전체: 종로를 골랐으면 예시 데이터 + 실제 장소 후보. */
export function includesSampleRegion(regions: Region[]): boolean {
  return regions.some((r) => r.id === SAMPLE_REGION_ID);
}

/** 아직 가져오지 못한 (지역, 카테고리) 후보 수. 0보다 크면 "장소를 찾는 중"으로 본다. */
export function pendingLiveCount(regions: Region[], stages: Stage[]): number {
  let count = 0;
  for (const region of regions) {
    if (region.id === SAMPLE_REGION_ID) continue;
    const seen = new Set<string>();
    for (const s of stages) {
      if (s.kind !== "recommend") continue;
      const k = keyOf(region, s.category, s.subCategory);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!cache.has(k)) count++;
    }
  }
  return count;
}
