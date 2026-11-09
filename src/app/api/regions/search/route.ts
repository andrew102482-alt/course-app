import { NextResponse } from "next/server";
import { parseRegionAddress } from "@/lib/regions";

// 코스 시작 지역 검색: 네이버 Geocoding으로 전국의 구·동 이름을 찾는다. 키는 서버에서만 읽는다.
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const id = process.env.NCP_MAPS_CLIENT_ID;
  const secret = process.env.NCP_MAPS_CLIENT_SECRET;
  if (q.length < 2 || q.length > 30 || !id || !secret) {
    return NextResponse.json({ results: [] });
  }
  // 이름 일부만 쳐도("해운대", "안암") 찾도록 동·구·시를 붙인 이름도 함께 찾는다.
  const hasSuffix = /[시군구읍면동리가]$/.test(q);
  const queries = hasSuffix ? [q] : [q, `${q}동`, `${q}구`, `${q}시`];
  const geocode = async (query: string) => {
    try {
      const res = await fetch(
        `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(query)}&count=10`,
        {
          headers: {
            "X-NCP-APIGW-API-KEY-ID": id,
            "X-NCP-APIGW-API-KEY": secret,
          },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        addresses?: {
          jibunAddress?: string;
          roadAddress?: string;
          x: string;
          y: string;
        }[];
      };
      return data.addresses ?? [];
    } catch {
      return [];
    }
  };
  const lists = await Promise.all(queries.map(geocode));
  const seen = new Set<string>();
  const results = [];
  for (const a of lists.flat()) {
    const parsed = parseRegionAddress(a.jibunAddress || a.roadAddress || "");
    const lat = Number(a.y);
    const lng = Number(a.x);
    if (!parsed || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${parsed.areaId}|${parsed.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...parsed, lat, lng });
    if (results.length >= 8) break;
  }
  return NextResponse.json({ results });
}
