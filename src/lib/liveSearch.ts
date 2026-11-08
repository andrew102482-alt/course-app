import type { PlaceCategory } from "../data/places.ts";

/**
 * 예시 데이터가 없는 지역에서 장소를 찾을 때 TMAP에 던질 검색어.
 * 카테고리(+세부 카테고리)마다 검색어를 1~2개 쓰고, 결과를 합친다.
 */
const KEYWORDS: Record<
  PlaceCategory,
  { all: string[]; sub: Record<string, string[]> }
> = {
  "문화 생활": {
    all: ["미술관", "박물관"],
    sub: {
      공연: ["공연장", "극장"],
      전시: ["미술관", "전시관"],
      영화: ["영화관"],
      "축제·행사": ["문화센터", "축제"],
      "책·학습": ["서점", "도서관"],
      "역사·명소": ["고궁", "박물관"],
    },
  },
  액티비티: {
    all: ["방탈출", "볼링장", "공방"],
    sub: {
      "실내 스포츠": ["볼링장", "스크린골프"],
      "실외 스포츠": ["공원 운동장", "골프연습장"],
      엔터테인먼트: ["방탈출", "보드게임카페"],
      "체험·클래스": ["공방", "원데이클래스"],
      "자연·레저": ["공원", "수목원"],
      테마파크: ["테마파크", "놀이공원"],
      웰니스: ["스파", "찜질방"],
    },
  },
  맛집: {
    all: ["맛집", "식당"],
    sub: {
      한식: ["한식", "한정식"],
      일식: ["일식", "초밥"],
      중식: ["중식", "중화요리"],
      양식: ["양식", "파스타"],
      "아시안·세계": ["쌀국수", "아시안음식"],
      기타: ["분식", "고깃집"],
    },
  },
  카페: {
    all: ["카페", "커피"],
    sub: {
      커피: ["커피전문점", "카페"],
      디저트: ["디저트카페", "베이커리"],
      "차·음료": ["찻집", "전통찻집"],
      "공간 특화": ["루프탑카페", "대형카페"],
      테마형: ["테마카페", "북카페"],
    },
  },
  술집: {
    all: ["술집", "주점"],
    sub: {
      바: ["칵테일바", "와인바"],
      맥주: ["호프", "수제맥주"],
      전통주: ["막걸리", "전통주점"],
      주점: ["이자카야", "포장마차"],
      나이트라이프: ["클럽", "라운지바"],
    },
  },
  쇼핑: { all: ["쇼핑몰", "백화점"], sub: {} },
};

export function keywordsFor(
  category: PlaceCategory,
  subCategory?: string,
): string[] {
  const entry = KEYWORDS[category];
  if (!entry) return [];
  return (subCategory && entry.sub[subCategory]) || entry.all;
}

export function isPlaceCategory(value: string): value is PlaceCategory {
  return value in KEYWORDS;
}
