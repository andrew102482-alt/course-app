/**
 * 코스를 만들 지역 목록. 지역을 하나 이상(최대 MAX_REGIONS) 고르면 그 지역의 중심 좌표를 기준으로
 * 지도·장소 검색·장소 추천이 동작한다. 길찾기는 좌표만 있으면 전국 어디서나 된다.
 */
export type Region = {
  id: string;
  name: string;
  /** 시·도 이름(목록을 묶어 보여줄 때 쓴다). */
  area: string;
  lat: number;
  lng: number;
  /** 이 지역으로 보는 반경(미터). 추천 후보를 찾고, 지정 장소가 지역 밖인지 판단할 때 쓴다. */
  radius: number;
};

export const MAX_REGIONS = 3;
export const DEFAULT_REGION_ID = "jongno";

const R = (
  id: string,
  name: string,
  area: string,
  lat: number,
  lng: number,
  radius = 2500,
): Region => ({ id, name, area, lat, lng, radius });

export const REGIONS: Region[] = [
  R("jongno", "종로", "서울", 37.5759, 126.9825, 2200),
  R("myeongdong", "명동·을지로", "서울", 37.5636, 126.9826),
  R("hongdae", "홍대·합정", "서울", 37.5563, 126.9236),
  R("sinchon", "신촌·이대", "서울", 37.5559, 126.9368),
  R("itaewon", "이태원·한남", "서울", 37.5345, 126.9946),
  R("seongsu", "성수", "서울", 37.5446, 127.0557),
  R("konkuk", "건대·왕십리", "서울", 37.5404, 127.0692),
  R("gangnam", "강남·역삼", "서울", 37.4979, 127.0276),
  R("apgujeong", "압구정·신사", "서울", 37.5271, 127.0285),
  R("jamsil", "잠실·송파", "서울", 37.5133, 127.1001),
  R("yeouido", "여의도", "서울", 37.5219, 126.9245),
  R("yeonnam", "연남·망원", "서울", 37.5622, 126.9013),
  R("busan-seomyeon", "서면", "부산", 35.1579, 129.0595),
  R("busan-haeundae", "해운대", "부산", 35.1631, 129.1639),
  R("busan-gwangalli", "광안리", "부산", 35.1532, 129.1187),
  R("busan-nampo", "남포동·영도", "부산", 35.0978, 129.0306),
  R("daegu", "동성로", "대구", 35.8695, 128.5942),
  R("incheon-songdo", "송도", "인천", 37.3894, 126.6439),
  R("incheon-bupyeong", "부평", "인천", 37.4895, 126.7242),
  R("gwangju", "충장로", "광주", 35.1476, 126.9178),
  R("daejeon", "은행동·둔산", "대전", 36.3287, 127.4272),
  R("ulsan", "삼산·성남동", "울산", 35.5384, 129.3392),
  R("suwon", "수원 행궁동", "경기", 37.2823, 127.0126),
  R("seongnam", "판교·분당", "경기", 37.3947, 127.1112),
  R("goyang", "일산", "경기", 37.6584, 126.7699),
  R("gapyeong", "가평·양평", "경기", 37.5313, 127.4879, 6000),
  R("chuncheon", "춘천", "강원", 37.8813, 127.7298),
  R("gangneung", "강릉", "강원", 37.7519, 128.8761, 3500),
  R("sokcho", "속초", "강원", 38.207, 128.5918),
  R("cheongju", "청주", "충북", 36.6424, 127.489),
  R("cheonan", "천안·아산", "충남", 36.8151, 127.1139),
  R("jeonju", "전주 한옥마을", "전북", 35.8151, 127.153),
  R("yeosu", "여수", "전남", 34.7604, 127.6622, 3500),
  R("mokpo", "목포", "전남", 34.8118, 126.3922),
  R("pohang", "포항", "경북", 36.019, 129.3435),
  R("gyeongju", "경주", "경북", 35.8562, 129.2247, 3500),
  R("changwon", "창원", "경남", 35.2279, 128.6811),
  R("tongyeong", "통영", "경남", 34.8544, 128.4331),
  R("jeju-city", "제주시", "제주", 33.5, 126.5312, 3500),
  R("seogwipo", "서귀포", "제주", 33.2541, 126.5601, 3500),
];

const BY_ID = new Map(REGIONS.map((r) => [r.id, r]));

export function regionById(id: string): Region | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_REGION = BY_ID.get(DEFAULT_REGION_ID)!;

/** 저장돼 있던 id 목록을 실제 지역으로 바꾼다. 알 수 없는 id는 버리고, 비면 기본 지역(종로). */
export function resolveRegions(ids: unknown): Region[] {
  const list = Array.isArray(ids) ? ids : [];
  const found: Region[] = [];
  for (const id of list) {
    const r = typeof id === "string" ? BY_ID.get(id) : undefined;
    if (r && !found.includes(r)) found.push(r);
    if (found.length >= MAX_REGIONS) break;
  }
  return found.length > 0 ? found : [DEFAULT_REGION];
}

/** "종로", "종로 · 홍대·합정", "종로 외 2곳"처럼 한 줄로 줄인 지역 이름. */
export function regionsLabel(regions: Region[], max = 2): string {
  if (regions.length <= max) return regions.map((r) => r.name).join(" · ");
  return `${regions
    .slice(0, max - 1)
    .map((r) => r.name)
    .join(" · ")} 외 ${regions.length - (max - 1)}곳`;
}

const EARTH_RADIUS_METERS = 6371000;

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/** 점이 고른 지역들 중 하나의 반경 안에 있으면 true. */
export function isWithinRegions(
  point: { lat: number; lng: number },
  regions: Region[],
): boolean {
  return regions.some((r) => distanceMeters(point, r) <= r.radius);
}
