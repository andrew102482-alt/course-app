import { NextResponse } from "next/server";

// 네이버 Reverse Geocoding(좌표 → 주소). 지도 한가운데 핀이 가리키는 곳의 주소를 보여줄 때 쓴다.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const id = process.env.NCP_MAPS_CLIENT_ID;
  const secret = process.env.NCP_MAPS_CLIENT_SECRET;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !id || !secret) {
    return NextResponse.json({ address: null, name: null });
  }

  try {
    const res = await fetch(
      `https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&orders=roadaddr,addr&output=json`,
      {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": id,
          "X-NCP-APIGW-API-KEY": secret,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json({ address: null, name: null });
    type Area = { name?: string };
    const data = (await res.json()) as {
      results?: {
        name: string;
        region: Record<string, Area>;
        land?: {
          name?: string;
          number1?: string;
          number2?: string;
          addition0?: { type?: string; value?: string };
        };
      }[];
    };
    const list = data.results ?? [];
    const road = list.find((r) => r.name === "roadaddr");
    const jibun = list.find((r) => r.name === "addr");
    const pick = road ?? jibun;
    if (!pick) return NextResponse.json({ address: null, name: null });

    const area = (k: string) => pick.region[k]?.name ?? "";
    const num = pick.land?.number1
      ? pick.land.number2
        ? `${pick.land.number1}-${pick.land.number2}`
        : pick.land.number1
      : "";
    const parts = road
      ? [area("area1"), area("area2"), pick.land?.name ?? "", num]
      : [area("area1"), area("area2"), area("area3"), num];
    const address = parts.filter((p) => p.length > 0).join(" ");
    // 이름이 붙은 건물·장소(예: 경복궁, 3호선 안국역)면 그 이름도 함께 돌려준다.
    const named = list
      .map((r) => r.land?.addition0)
      .find((a) => a?.type === "building" && a.value);
    return NextResponse.json({
      address: address || null,
      name: named?.value ?? null,
    });
  } catch {
    return NextResponse.json({ address: null, name: null });
  }
}
