import { NextResponse } from "next/server";

// 네이버 Directions 5(길찾기). 자동차 도로 기준 경로선만 준다(도보 길찾기는 네이버에 없다).
// 권한이 없거나 실패하면 path: null → 화면은 직선으로 대신 그린다.
const COORD = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const start = params.get("start") ?? "";
  const goal = params.get("goal") ?? "";
  const id = process.env.NCP_MAPS_CLIENT_ID;
  const secret = process.env.NCP_MAPS_CLIENT_SECRET;
  if (!COORD.test(start) || !COORD.test(goal) || !id || !secret) {
    return NextResponse.json({ path: null });
  }

  try {
    const res = await fetch(
      `https://maps.apigw.ntruss.com/map-direction/v1/driving?start=${start}&goal=${goal}&option=trafast`,
      {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": id,
          "X-NCP-APIGW-API-KEY": secret,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json({ path: null });
    const data = (await res.json()) as {
      code?: number;
      route?: { trafast?: { path?: [number, number][] }[] };
    };
    const raw = data.code === 0 ? data.route?.trafast?.[0]?.path : undefined;
    if (!raw || raw.length < 2) return NextResponse.json({ path: null });
    // [lng, lat] → [lat, lng]
    return NextResponse.json({
      path: raw.map(([lng, lat]) => [lat, lng] as [number, number]),
    });
  } catch {
    return NextResponse.json({ path: null });
  }
}
