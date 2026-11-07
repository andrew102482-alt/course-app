import { NextResponse } from "next/server";

// TMAP 보행자 경로안내. 도보 경로선과 실제 소요 시간·거리를 준다.
// 실패하면 path: null → 화면은 직선으로 대신 그린다. appKey는 서버에서만 읽는다.
const COORD = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const start = params.get("start") ?? "";
  const goal = params.get("goal") ?? "";
  const key = process.env.TMAP_APP_KEY;
  const none = { path: null, minutes: null, meters: null };
  if (!COORD.test(start) || !COORD.test(goal) || !key) {
    return NextResponse.json(none);
  }
  const [startX, startY] = start.split(",").map(Number);
  const [endX, endY] = goal.split(",").map(Number);

  try {
    const res = await fetch(
      "https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1",
      {
        method: "POST",
        headers: { appKey: key, "Content-Type": "application/json" },
        body: JSON.stringify({
          startX,
          startY,
          endX,
          endY,
          reqCoordType: "WGS84GEO",
          resCoordType: "WGS84GEO",
          startName: encodeURIComponent("출발"),
          endName: encodeURIComponent("도착"),
        }),
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json(none);
    const data = (await res.json()) as {
      features?: {
        geometry: { type: string; coordinates: unknown };
        properties: { totalTime?: number; totalDistance?: number };
      }[];
    };
    const features = data.features ?? [];
    const summary = features.find(
      (f) => f.properties.totalTime !== undefined,
    )?.properties;
    const path: [number, number][] = [];
    for (const f of features) {
      if (f.geometry.type !== "LineString") continue;
      for (const [lng, lat] of f.geometry.coordinates as [number, number][]) {
        const last = path[path.length - 1];
        if (!last || last[0] !== lat || last[1] !== lng) path.push([lat, lng]);
      }
    }
    if (path.length < 2) return NextResponse.json(none);
    return NextResponse.json({
      path,
      minutes: summary?.totalTime ? summary.totalTime / 60 : null,
      meters: summary?.totalDistance ?? null,
    });
  } catch {
    return NextResponse.json(none);
  }
}
