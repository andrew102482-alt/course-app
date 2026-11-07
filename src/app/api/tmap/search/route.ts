import { NextResponse } from "next/server";

// TMAP POI 통합검색(장소 이름 → 이름·주소·좌표). appKey는 서버에서만 읽는다.
const CENTER = { lat: 37.5759, lng: 126.9825 }; // 종로 중심: 가까운 곳을 먼저 보여주려고 넘긴다.

type Poi = {
  id: string;
  name: string;
  noorLat: string;
  noorLon: string;
  upperAddrName?: string;
  middleAddrName?: string;
  lowerAddrName?: string;
  detailAddrName?: string;
  firstNo?: string;
  secondNo?: string;
  roadName?: string;
  firstBuildNo?: string;
  secondBuildNo?: string;
  middleBizName?: string;
  lowerBizName?: string;
};

function joinNo(a?: string, b?: string): string {
  if (!a || a === "0") return "";
  return b && b !== "0" ? `${a}-${b}` : a;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const key = process.env.TMAP_APP_KEY;
  if (!q || q.length > 60 || !key) return NextResponse.json({ results: [] });

  try {
    const res = await fetch(
      `https://apis.openapi.sk.com/tmap/pois?version=1&searchKeyword=${encodeURIComponent(q)}&count=8&resCoordType=WGS84GEO&reqCoordType=WGS84GEO&centerLon=${CENTER.lng}&centerLat=${CENTER.lat}`,
      { headers: { appKey: key }, cache: "no-store" },
    );
    if (!res.ok) return NextResponse.json({ results: [] });
    // 검색 결과가 없으면 TMAP이 빈 본문을 줄 수 있다.
    const text = await res.text();
    if (!text) return NextResponse.json({ results: [] });
    const data = JSON.parse(text) as {
      searchPoiInfo?: { pois?: { poi?: Poi[] } };
    };
    // 같은 장소가 여러 번(주차장·정문·후문 등 출입구 지점으로) 나오는 경우를 정리한다.
    // 검색어에 직접 그 말을 쓴 경우는 그대로 둔다.
    const wantsGate = /(주차장|정문|후문|입구|출입구)/.test(q);
    const seen = new Set<string>();
    const pois = (data.searchPoiInfo?.pois?.poi ?? []).filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return wantsGate || !/(주차장|정문|후문|입구|출입구)$/.test(p.name);
    });
    const results = pois
      .map((p) => {
        const road = p.roadName
          ? `${p.roadName} ${joinNo(p.firstBuildNo, p.secondBuildNo)}`.trim()
          : `${p.lowerAddrName ?? ""} ${p.detailAddrName ?? ""} ${joinNo(p.firstNo, p.secondNo)}`.trim();
        const address = [p.upperAddrName, p.middleAddrName, road]
          .filter(Boolean)
          .join(" ");
        return {
          id: `tmap-${p.id}`,
          name: p.name,
          category: p.lowerBizName || p.middleBizName || "장소",
          address,
          lat: Number(p.noorLat),
          lng: Number(p.noorLon),
        };
      })
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
