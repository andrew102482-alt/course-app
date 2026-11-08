import { NextResponse } from "next/server";
import { isPlaceCategory, keywordsFor } from "@/lib/liveSearch";

// 예시 데이터가 없는 지역의 추천 후보를 TMAP 장소 검색(중심 좌표 주변)으로 찾는다.
// TMAP은 평점·영업시간을 주지 않으므로, 이름·분류·좌표·주소만 돌려준다.
type Poi = {
  id: string;
  name: string;
  noorLat: string;
  noorLon: string;
  upperAddrName?: string;
  middleAddrName?: string;
  lowerAddrName?: string;
  roadName?: string;
  firstBuildNo?: string;
  middleBizName?: string;
  lowerBizName?: string;
};

const NOT_A_PLACE = /(주차장|정문|후문|입구|출입구|매표소|화장실)$/;

async function searchOne(
  key: string,
  keyword: string,
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<Poi[]> {
  const url =
    `https://apis.openapi.sk.com/tmap/pois?version=1&searchKeyword=${encodeURIComponent(keyword)}` +
    `&searchtypCd=R&radius=${radiusKm}&count=20&resCoordType=WGS84GEO&reqCoordType=WGS84GEO` +
    `&centerLon=${lng}&centerLat=${lat}`;
  const res = await fetch(url, { headers: { appKey: key }, cache: "no-store" });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text) as {
    searchPoiInfo?: { pois?: { poi?: Poi[] } };
  };
  return data.searchPoiInfo?.pois?.poi ?? [];
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lng = Number(p.get("lng"));
  const radius = Math.min(Math.max(Number(p.get("r")) || 2500, 500), 8000);
  const category = p.get("category") ?? "";
  const sub = p.get("sub") ?? undefined;
  const key = process.env.TMAP_APP_KEY;
  if (
    !key ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < 33 ||
    lat > 39 ||
    lng < 124 ||
    lng > 132 ||
    !isPlaceCategory(category) ||
    (sub !== undefined && sub.length > 20)
  ) {
    return NextResponse.json({ results: [] });
  }

  try {
    const lists = await Promise.all(
      keywordsFor(category, sub).map((k) =>
        searchOne(key, k, lat, lng, Math.ceil(radius / 1000)).catch(() => []),
      ),
    );
    const seen = new Set<string>();
    const results = lists
      .flat()
      .filter((poi) => {
        if (seen.has(poi.id) || NOT_A_PLACE.test(poi.name)) return false;
        seen.add(poi.id);
        return true;
      })
      .map((poi) => ({
        id: `tmap-${poi.id}`,
        name: poi.name,
        category,
        subCategory: sub,
        bizName: poi.lowerBizName || poi.middleBizName || "",
        region: [poi.middleAddrName, poi.lowerAddrName]
          .filter(Boolean)
          .join(" "),
        lat: Number(poi.noorLat),
        lng: Number(poi.noorLon),
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
