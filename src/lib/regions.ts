/**
 * 출발 지역. 시·도(큰 단위) 하나를 고르고, 원하면 그 안의 동(작은 단위)을 하나 더 고른다.
 * 이 지역은 코스의 "출발 기준"일 뿐이라 코스가 꼭 이 안에 머물지는 않는다
 * (첫 장소는 출발 지역 주변에서 찾고, 그다음 장소는 직전 장소 주변에서 찾는다).
 */
export type Region = {
  id: string;
  name: string;
  /** 시·도 이름. */
  area: string;
  areaId: string;
  lat: number;
  lng: number;
  /** 첫 장소를 찾을 반경(미터). */
  radius: number;
};

export type Area = {
  id: string;
  name: string;
  /** 동을 고르지 않았을 때의 대표 중심. */
  lat: number;
  lng: number;
  radius: number;
};

export type RegionSelection = { areaId: string; dongId: string | null };

export const AREAS: Area[] = [
  { id: "seoul", name: "서울", lat: 37.5665, lng: 126.978, radius: 3000 },
  { id: "busan", name: "부산", lat: 35.1796, lng: 129.0756, radius: 3000 },
  { id: "daegu", name: "대구", lat: 35.8695, lng: 128.5942, radius: 3000 },
  { id: "incheon", name: "인천", lat: 37.4563, lng: 126.7052, radius: 3000 },
  { id: "gwangju", name: "광주", lat: 35.1476, lng: 126.9178, radius: 3000 },
  { id: "daejeon", name: "대전", lat: 36.3504, lng: 127.3845, radius: 3000 },
  { id: "ulsan", name: "울산", lat: 35.5384, lng: 129.3114, radius: 3000 },
  { id: "gyeonggi", name: "경기", lat: 37.2636, lng: 127.0286, radius: 3000 },
  { id: "gangwon", name: "강원", lat: 37.8813, lng: 127.7298, radius: 3000 },
  { id: "chungcheong", name: "충청", lat: 36.6424, lng: 127.489, radius: 3000 },
  { id: "jeolla", name: "전라", lat: 35.8242, lng: 127.148, radius: 3000 },
  { id: "gyeongsang", name: "경상", lat: 35.8562, lng: 129.2247, radius: 3000 },
  { id: "jeju", name: "제주", lat: 33.4996, lng: 126.5312, radius: 3500 },
];

const D = (
  id: string,
  areaId: string,
  name: string,
  lat: number,
  lng: number,
  radius = 1500,
): Region => ({
  id,
  name,
  areaId,
  area: AREAS.find((a) => a.id === areaId)?.name ?? "",
  lat,
  lng,
  radius,
});

export const DONGS: Region[] = [
  // 서울
  D("jongno", "seoul", "종로", 37.5759, 126.9825, 2200),
  D("seochon", "seoul", "서촌·청운동", 37.5815, 126.9695),
  D("bukchon", "seoul", "북촌·삼청동", 37.5826, 126.983),
  D("gwanghwamun", "seoul", "광화문·시청", 37.5712, 126.9769),
  D("myeongdong", "seoul", "명동·을지로", 37.5636, 126.9826),
  D("dongdaemun", "seoul", "동대문", 37.5712, 127.0095),
  D("hyehwa", "seoul", "혜화·대학로", 37.5823, 127.0018),
  D("sindang", "seoul", "약수·신당", 37.5545, 127.0105),
  D("yongsan", "seoul", "용산·삼각지", 37.534, 126.973),
  D("itaewon", "seoul", "이태원·한남", 37.5345, 126.9946),
  D("hongdae", "seoul", "홍대", 37.5563, 126.9236),
  D("hapjeong", "seoul", "합정·상수", 37.5496, 126.9137),
  D("yeonnam", "seoul", "연남동", 37.5625, 126.9255),
  D("mangwon", "seoul", "망원동", 37.556, 126.91),
  D("sinchon", "seoul", "신촌·이대", 37.5559, 126.9368),
  D("yeouido", "seoul", "여의도", 37.5219, 126.9245),
  D("yeongdeungpo", "seoul", "영등포·문래", 37.5176, 126.8963),
  D("noryangjin", "seoul", "노량진", 37.513, 126.9422),
  D("seongsu", "seoul", "성수동", 37.5446, 127.0557),
  D("seoulforest", "seoul", "서울숲·뚝섬", 37.5444, 127.0374),
  D("konkuk", "seoul", "건대입구", 37.5404, 127.0692),
  D("wangsimni", "seoul", "왕십리", 37.5612, 127.0371),
  D("apgujeong", "seoul", "압구정·신사", 37.5271, 127.0285),
  D("cheongdam", "seoul", "청담동", 37.5247, 127.0473),
  D("gangnam", "seoul", "강남·역삼", 37.4979, 127.0276),
  D("seolleung", "seoul", "선릉·삼성", 37.5045, 127.049),
  D("seorae", "seoul", "서래마을·교대", 37.4985, 126.9966),
  D("jamsil", "seoul", "잠실", 37.5133, 127.1001),
  D("songpa", "seoul", "송리단길·석촌", 37.5057, 127.1093),
  D("sinlim", "seoul", "신림·사당", 37.4846, 126.9296),
  // 부산
  D("busan-seomyeon", "busan", "서면", 35.1579, 129.0595),
  D("busan-jeonpo", "busan", "전포동", 35.1536, 129.064),
  D("busan-haeundae", "busan", "해운대", 35.1631, 129.1639),
  D("busan-centum", "busan", "센텀시티", 35.1696, 129.131),
  D("busan-gwangalli", "busan", "광안리", 35.1532, 129.1187),
  D("busan-songjeong", "busan", "송정", 35.1786, 129.199),
  D("busan-nampo", "busan", "남포동·자갈치", 35.0978, 129.0306),
  D("busan-youngdo", "busan", "영도", 35.078, 129.082),
  D("busan-university", "busan", "부산대", 35.23, 129.084),
  D("busan-dongnae", "busan", "동래", 35.2057, 129.0786),
  D("busan-gijang", "busan", "기장", 35.2445, 129.2222),
  // 대구
  D("daegu-dongseongno", "daegu", "동성로", 35.8695, 128.5942),
  D("daegu-suseong", "daegu", "수성못", 35.8284, 128.6166),
  D("daegu-kimkwangseok", "daegu", "김광석길", 35.8577, 128.6063),
  D("daegu-apsan", "daegu", "앞산", 35.824, 128.587),
  // 인천
  D("incheon-songdo", "incheon", "송도", 37.3894, 126.6439),
  D("incheon-bupyeong", "incheon", "부평", 37.4895, 126.7242),
  D("incheon-chinatown", "incheon", "차이나타운", 37.4755, 126.619),
  D("incheon-wolmi", "incheon", "월미도", 37.475, 126.598),
  D("incheon-guwol", "incheon", "구월동", 37.449, 126.705),
  // 광주
  D("gwangju-chungjang", "gwangju", "충장로", 35.1476, 126.9178),
  D("gwangju-sangmu", "gwangju", "상무지구", 35.1527, 126.8493),
  D("gwangju-yangnim", "gwangju", "양림동", 35.1384, 126.915),
  D("gwangju-dongmyeong", "gwangju", "동명동", 35.148, 126.929),
  // 대전
  D("daejeon-eunhaeng", "daejeon", "은행동", 36.3287, 127.4272),
  D("daejeon-dunsan", "daejeon", "둔산동", 36.351, 127.385),
  D("daejeon-yuseong", "daejeon", "유성온천", 36.355, 127.343),
  // 울산
  D("ulsan-samsan", "ulsan", "삼산동", 35.5384, 129.3392),
  D("ulsan-seongnam", "ulsan", "성남동", 35.5517, 129.3166),
  D("ulsan-daewangam", "ulsan", "대왕암공원", 35.495, 129.438),
  // 경기
  D("suwon-haenggung", "gyeonggi", "수원 행궁동", 37.2823, 127.0126),
  D("suwon-gwanggyo", "gyeonggi", "수원 광교", 37.287, 127.056),
  D("seongnam-pangyo", "gyeonggi", "판교", 37.3947, 127.1112),
  D("seongnam-seohyeon", "gyeonggi", "분당 서현", 37.385, 127.123),
  D("goyang-ilsan", "gyeonggi", "일산", 37.6584, 126.7699),
  D("anyang-pyeongchon", "gyeonggi", "안양 평촌", 37.39, 126.95),
  D("bucheon", "gyeonggi", "부천", 37.483, 126.783),
  D("paju-heyri", "gyeonggi", "파주 헤이리", 37.759, 126.699),
  D("hanam", "gyeonggi", "하남 스타필드", 37.545, 127.224),
  D("gapyeong", "gyeonggi", "가평", 37.8315, 127.51, 4000),
  D("yangpyeong", "gyeonggi", "양평", 37.491, 127.487, 4000),
  // 강원
  D("chuncheon", "gangwon", "춘천", 37.8813, 127.7298),
  D("gangneung-anmok", "gangwon", "강릉 안목해변", 37.771, 128.949),
  D("gangneung-gyeongpo", "gangwon", "강릉 경포", 37.795, 128.908),
  D("gangneung-center", "gangwon", "강릉 중앙시장", 37.7519, 128.8961),
  D("sokcho", "gangwon", "속초", 38.207, 128.5918),
  D("yangyang", "gangwon", "양양", 37.969, 128.759, 3000),
  D("wonju", "gangwon", "원주", 37.3422, 127.92),
  // 충청
  D("cheongju", "chungcheong", "청주", 36.6424, 127.489),
  D("cheonan", "chungcheong", "천안", 36.8151, 127.1139),
  D("asan", "chungcheong", "아산 온양", 36.78, 127.004),
  D("gongju", "chungcheong", "공주", 36.456, 127.119),
  D("buyeo", "chungcheong", "부여", 36.275, 126.91),
  D("taean", "chungcheong", "태안 안면도", 36.51, 126.33, 4000),
  D("chungju", "chungcheong", "충주", 36.991, 127.926),
  // 전라
  D("jeonju-hanok", "jeolla", "전주 한옥마을", 35.8151, 127.153),
  D("jeonju-gaekri", "jeolla", "전주 객리단길", 35.818, 127.148),
  D("gunsan", "jeolla", "군산", 35.976, 126.711),
  D("iksan", "jeolla", "익산", 35.948, 126.957),
  D("yeosu", "jeolla", "여수 중앙동", 34.743, 127.738),
  D("yeosu-dolsan", "jeolla", "여수 돌산", 34.739, 127.74),
  D("suncheon-bay", "jeolla", "순천만", 34.887, 127.511),
  D("suncheon", "jeolla", "순천 시내", 34.95, 127.487),
  D("mokpo", "jeolla", "목포", 34.8118, 126.3922),
  D("damyang", "jeolla", "담양", 35.321, 126.988),
  // 경상
  D("pohang-yeongildae", "gyeongsang", "포항 영일대", 36.056, 129.383),
  D("gyeongju-hwangnidan", "gyeongsang", "경주 황리단길", 35.839, 129.21),
  D("gyeongju-bulguksa", "gyeongsang", "경주 불국사", 35.79, 129.332),
  D("gyeongju-bomun", "gyeongsang", "경주 보문단지", 35.842, 129.285),
  D("changwon-sangnam", "gyeongsang", "창원 상남동", 35.222, 128.691),
  D("tongyeong", "gyeongsang", "통영", 34.8544, 128.4331),
  D("geoje", "gyeongsang", "거제", 34.88, 128.621, 3000),
  D("andong", "gyeongsang", "안동", 36.568, 128.729),
  D("jinju", "gyeongsang", "진주", 35.18, 128.107),
  D("gimhae", "gyeongsang", "김해", 35.228, 128.889),
  // 제주
  D("jeju-city", "jeju", "제주 시내", 33.51, 126.5219),
  D("jeju-yeondong", "jeju", "제주 연동", 33.489, 126.493),
  D("jeju-aewol", "jeju", "애월", 33.462, 126.31, 3000),
  D("jeju-hamdeok", "jeju", "함덕", 33.543, 126.67, 3000),
  D("jeju-hyeopjae", "jeju", "협재", 33.394, 126.239, 3000),
  D("seogwipo", "jeju", "서귀포", 33.2541, 126.5601, 3000),
  D("jeju-jungmun", "jeju", "중문", 33.25, 126.412, 3000),
  D("jeju-seongsan", "jeju", "성산", 33.458, 126.94, 3000),
];

export const DEFAULT_SELECTION: RegionSelection = {
  areaId: "seoul",
  dongId: "jongno",
};

const AREA_BY_ID = new Map(AREAS.map((a) => [a.id, a]));
const DONG_BY_ID = new Map(DONGS.map((d) => [d.id, d]));

export function dongsOf(areaId: string): Region[] {
  return DONGS.filter((d) => d.areaId === areaId);
}

/** 저장돼 있던 값(새 형식, 또는 예전의 지역 id 목록)을 올바른 선택으로 바꾼다. 알 수 없으면 서울·종로. */
export function resolveSelection(raw: unknown): RegionSelection {
  const first =
    Array.isArray(raw) && typeof raw[0] === "string"
      ? { dongId: raw[0] }
      : (raw as { areaId?: unknown; dongId?: unknown } | null);
  const dong =
    typeof first?.dongId === "string"
      ? DONG_BY_ID.get(first.dongId)
      : undefined;
  if (dong) return { areaId: dong.areaId, dongId: dong.id };
  const areaId =
    first && "areaId" in first && typeof first.areaId === "string"
      ? first.areaId
      : "";
  if (AREA_BY_ID.has(areaId)) return { areaId, dongId: null };
  return DEFAULT_SELECTION;
}

/** 선택을 출발 기준 지역(동을 골랐으면 그 동, 아니면 시·도 대표 중심) 목록으로 바꾼다. */
export function selectionRegions(selection: RegionSelection): Region[] {
  const dong = selection.dongId ? DONG_BY_ID.get(selection.dongId) : undefined;
  if (dong && dong.areaId === selection.areaId) return [dong];
  const area = AREA_BY_ID.get(selection.areaId) ?? AREAS[0];
  return [
    {
      id: `area-${area.id}`,
      name: area.name,
      area: area.name,
      areaId: area.id,
      lat: area.lat,
      lng: area.lng,
      radius: area.radius,
    },
  ];
}

export const DEFAULT_REGION: Region = selectionRegions(DEFAULT_SELECTION)[0];

/** "서울 · 종로"처럼 화면에 보여줄 이름. 동을 안 골랐으면 시·도만. */
export function selectionLabel(selection: RegionSelection): string {
  const [r] = selectionRegions(selection);
  return r.id.startsWith("area-") ? r.name : `${r.area} · ${r.name}`;
}

export function regionById(id: string): Region | undefined {
  return DONG_BY_ID.get(id);
}

/** 지역 하나를 화면에 보여줄 이름("서울 · 종로", 동 없이 시·도만이면 "서울"). */
export function regionLabel(region: Region): string {
  return region.id.startsWith("area-")
    ? region.name
    : `${region.area} · ${region.name}`;
}
