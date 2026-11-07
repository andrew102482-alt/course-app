import { NextResponse } from "next/server";

// 네이버 Geocoding(주소 → 좌표). 키는 서버에서만 읽는다.
// 주의: 이 API는 "주소" 검색이라 "경복궁" 같은 장소 이름은 찾지 못한다.
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const id = process.env.NCP_MAPS_CLIENT_ID;
  const secret = process.env.NCP_MAPS_CLIENT_SECRET;
  if (!q || q.length > 100 || !id || !secret) {
    return NextResponse.json({ results: [] });
  }

  try {
    const res = await fetch(
      `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(q)}&count=5`,
      {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": id,
          "X-NCP-APIGW-API-KEY": secret,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json({ results: [] });
    const data = (await res.json()) as {
      addresses?: {
        roadAddress?: string;
        jibunAddress?: string;
        x: string;
        y: string;
      }[];
    };
    const results = (data.addresses ?? [])
      .map((a, i) => {
        const address = a.roadAddress || a.jibunAddress || q;
        return {
          id: `geo-${a.x}-${a.y}-${i}`,
          name: address,
          category: "주소",
          address: a.jibunAddress || address,
          lat: Number(a.y),
          lng: Number(a.x),
        };
      })
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
