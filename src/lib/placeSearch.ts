import { places } from "@/data/places";
import type { DesignatedPlace } from "./course";

/** 장소 검색 결과. 지정 장소가 될 값에 목록에 보여줄 분류 이름을 더한 것. */
export type PlaceSearchResult = DesignatedPlace & { category: string };

/**
 * 임시 검색 데이터. 네이버 키 발급 전까지 "이름을 치면 목록에서 고른다"는 흐름을 보여주기 위한
 * 대표 장소들이다(좌표는 대략값). 네이버 장소 검색을 붙이면 `searchPlaces`만 교체하면 된다.
 */
const LANDMARKS: PlaceSearchResult[] = [
  { id: "lm-anguk", name: "안국역", category: "지하철역", address: "서울 종로구 율곡로 안국역", lat: 37.5766, lng: 126.9854 },
  { id: "lm-jonggak", name: "종각역", category: "지하철역", address: "서울 종로구 종로 54", lat: 37.5702, lng: 126.9831 },
  { id: "lm-jongno3", name: "종로3가역", category: "지하철역", address: "서울 종로구 종로 지하 130", lat: 37.5714, lng: 126.9917 },
  { id: "lm-gyeongbok", name: "경복궁", category: "관광명소", address: "서울 종로구 사직로 161", lat: 37.5796, lng: 126.977 },
  { id: "lm-gwanghwamun", name: "광화문", category: "관광명소", address: "서울 종로구 세종로 1-57", lat: 37.576, lng: 126.9769 },
  { id: "lm-changdeok", name: "창덕궁", category: "관광명소", address: "서울 종로구 율곡로 99", lat: 37.5794, lng: 126.991 },
  { id: "lm-jongmyo", name: "종묘", category: "관광명소", address: "서울 종로구 종로 157", lat: 37.5744, lng: 126.9943 },
  { id: "lm-bukchon", name: "북촌한옥마을", category: "관광명소", address: "서울 종로구 계동길 37", lat: 37.5826, lng: 126.9835 },
  { id: "lm-ikseon", name: "익선동 한옥거리", category: "거리·골목", address: "서울 종로구 수표로28길", lat: 37.5742, lng: 126.9906 },
  { id: "lm-insadong", name: "인사동 쌈지길", category: "거리·골목", address: "서울 종로구 인사동길 44", lat: 37.5743, lng: 126.9849 },
  { id: "lm-samcheong", name: "삼청동 카페거리", category: "거리·골목", address: "서울 종로구 삼청로", lat: 37.583, lng: 126.9822 },
  { id: "lm-tongin", name: "통인시장", category: "시장", address: "서울 종로구 자하문로15길 18", lat: 37.5805, lng: 126.9695 },
  { id: "lm-gwangjang", name: "광장시장", category: "시장", address: "서울 종로구 창경궁로 88", lat: 37.5701, lng: 126.9996 },
  { id: "lm-mmca", name: "국립현대미술관 서울", category: "미술관", address: "서울 종로구 삼청로 30", lat: 37.5788, lng: 126.9804 },
  { id: "lm-sejong", name: "세종문화회관", category: "공연장", address: "서울 종로구 세종대로 175", lat: 37.5724, lng: 126.9759 },
  { id: "lm-kyobo", name: "교보문고 광화문점", category: "서점", address: "서울 종로구 종로 1", lat: 37.571, lng: 126.9769 },
  { id: "lm-cheonggye", name: "청계광장", category: "광장", address: "서울 종로구 청계천로 1", lat: 37.5689, lng: 126.9782 },
  // 종로 일대 밖(지역 밖 안내를 확인할 수 있는 예)
  { id: "lm-seoulst", name: "서울역", category: "지하철역", address: "서울 중구 한강대로 405", lat: 37.5547, lng: 126.9707 },
  { id: "lm-hongdae", name: "홍대입구역", category: "지하철역", address: "서울 마포구 양화로 160", lat: 37.5568, lng: 126.9237 },
  { id: "lm-gangnam", name: "강남역", category: "지하철역", address: "서울 강남구 강남대로 396", lat: 37.4979, lng: 127.0276 },
];

const SAMPLE_PLACES: PlaceSearchResult[] = places.map((p) => ({
  id: `sample-${p.id}`,
  name: p.name,
  category: p.subCategory ? `${p.category} · ${p.subCategory}` : p.category,
  address: `서울 종로구 ${p.region} 일대 (예시 장소)`,
  lat: p.lat,
  lng: p.lng,
}));

const SEARCHABLE: PlaceSearchResult[] = [...LANDMARKS, ...SAMPLE_PLACES];

const MAX_RESULTS = 8;

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/** 이름에 검색어가 들어 있는 장소를 찾는다. 이름이 검색어로 시작하는 곳을 먼저 보여준다. */
export function searchPlaces(query: string): PlaceSearchResult[] {
  const q = normalize(query);
  if (!q) return [];
  const matched = SEARCHABLE.filter((p) => normalize(p.name).includes(q));
  const startsWith = matched.filter((p) => normalize(p.name).startsWith(q));
  const rest = matched.filter((p) => !normalize(p.name).startsWith(q));
  return [...startsWith, ...rest].slice(0, MAX_RESULTS);
}
