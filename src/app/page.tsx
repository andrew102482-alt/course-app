"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Reorder, useDragControls } from "framer-motion";
import { places, type Place, type PlaceCategory } from "@/data/places";
import {
  REGION_CENTER,
  buildCourse,
  naverMapLinkFor,
  walkingMinutesBetween,
  type CourseResult,
  type DesignatedPlace,
  type RecommendStageResult,
  type Stage,
  type StageOverrides,
  type StageResult,
} from "@/lib/course";
import {
  MAP_LANDMARKS,
  searchPlaces,
  type PlaceSearchResult,
} from "@/lib/placeSearch";
import NaverMapCanvas, {
  type MapBubble,
  type MapLine,
  type MapMarker,
} from "@/components/NaverMapCanvas";
import { useNaverMaps } from "@/lib/useNaverMaps";
import { useRoadPaths } from "@/lib/useRoadPaths";
import { separateOverlaps } from "@/lib/lineOffset";
import { computeProgress, formatMeters, turnIcon } from "@/lib/guidance";
import {
  buildAiRequest,
  MAX_STAGE_TYPE_NOTE_LENGTH,
  stageLabel,
  type AiPicks,
} from "@/lib/aiRecommend";
import { saveCourse, toSavedCourse } from "@/lib/savedCourses";
import {
  getBlurb,
  blurbVersion,
  requestBlurbs,
  subscribeBlurbs,
} from "@/lib/blurb";
import {
  AREAS,
  DEFAULT_REGION,
  DEFAULT_SELECTION,
  DONGS,
  regionLabel,
  resolveSelection,
  selectionRegions,
  type Region,
  type RegionSelection,
} from "@/lib/regions";
import {
  getLivePlaces,
  includesSampleRegion,
  isLoadingLive,
  livePlacesVersion,
  loadLivePlacesForCourse,
  subscribeLivePlaces,
} from "@/lib/livePlaces";
import { AvatarCustomizer, AvatarFigure } from "./AvatarCustomizer";
import { PrivacyPolicySheet } from "./PrivacyPolicySheet";
import {
  DEFAULT_AVATAR,
  MAX_NICKNAME_LENGTH,
  loadAvatar,
  loadNickname,
  saveNickname,
  type Avatar,
} from "./avatar";

const MIN_TRAVEL_MINUTES = 5;
const TRAVEL_MINUTES_STEP = 5;
const MAX_TRAVEL_MINUTES = 30;
const DEFAULT_TRAVEL_MINUTES = 15;
/** 최대 이동시간을 "상관 없음"으로 고른 상태를 나타내는 값(저장도 이 값으로 한다). */
const UNLIMITED_TRAVEL = 0;
/** "상관 없음"일 때 계산에 쓰는 이동시간 한도(사실상 제한 없음). */
const UNLIMITED_TRAVEL_LIMIT_MINUTES = 45;
const MAX_STAGES = 8;
const MAX_RECENT_DESIGNATED = 10;

/** "현재 위치로 지정"으로 만든 지정 장소의 id. */
const CURRENT_LOCATION_PLACE_ID = "current-location";
/** "지도에서 지정"으로 만든 지정 장소의 id. */
const MAP_PICK_PLACE_ID = "map-pick";
const LAST_INPUT_STORAGE_KEY = "course-app:last-input";
const RECENT_DESIGNATED_STORAGE_KEY = "course-app:recent-designated";
const PERSONAL_CODE_STORAGE_KEY = "course-app:personal-code";
// 헷갈리기 쉬운 글자(0/O, 1/I)는 뺀 개인 코드용 글자들.
const PERSONAL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PERSONAL_CODE_LENGTH = 6;
const FRIENDS_STORAGE_KEY = "course-app:friends";
const FRIEND_REQUESTS_STORAGE_KEY = "course-app:friend-requests";
const GROUPS_STORAGE_KEY = "course-app:groups";
const PLAN_DATE_STORAGE_KEY = "course-app:plan-date";
const THEME_NOTE_STORAGE_KEY = "course-app:theme-note";
const MEET_TIMES_STORAGE_KEY = "course-app:meet-times";
/** 헤어지는 시간은 다음날 오전 11시(=35시)까지 고를 수 있다. */
const MAX_END_HOUR = 35;
const MAX_THEME_NOTE_LENGTH = 300;
const MAX_GROUP_NAME_LENGTH = 20;

let nextId = 1;
function generateId(prefix: string) {
  // localStorage에 저장된 이전 세션의 id와 겹치지 않도록, 페이지가 새로 열릴 때마다
  // 초기화되는 카운터 대신 브라우저가 제공하는 무작위 값을 사용한다.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${nextId++}`;
}

const REGIONS_STORAGE_KEY = "course-app:regions";

/** 고른 지역들. 지도·장소 검색·추천이 모두 이 지역을 기준으로 동작한다. */
type RegionContextValue = {
  regions: Region[];
  /** 첫 번째로 고른 지역의 중심(지도를 처음 열 때, 위치를 모를 때의 기준점). */
  center: { lat: number; lng: number };
  /** 이 지역의 추천 후보 장소를 아직 찾는 중이면 true. */
  loadingPlaces: boolean;
};
const RegionContext = createContext<RegionContextValue>({
  regions: [DEFAULT_REGION],
  center: DEFAULT_REGION,
  loadingPlaces: false,
});
function useRegionContext() {
  return useContext(RegionContext);
}

/** 코스 계산에 쓸 장소 전체: 종로를 골랐으면 예시 데이터, 다른 지역은 TMAP에서 가져온 실제 장소. */
function buildPool(regions: Region[]): Place[] {
  return [...(includesSampleRegion(regions) ? places : []), ...getLivePlaces()];
}

/** 이전 버전에서 저장된 카테고리·세부 카테고리 이름을 지금 이름으로 바꾼다. */
const OLD_SUB_CATEGORY_NAMES: Record<string, string> = {
  브런치: "커피",
  "커피 중심": "커피",
  "디저트 중심": "디저트",
  뷰: "공간 특화",
};

function migrateStage(stage: Stage): Stage {
  if (stage.kind !== "recommend") return stage;
  const oldCategory = stage.category as string;
  const category = (
    oldCategory === "전시" ? "문화 생활" : oldCategory
  ) as PlaceCategory;
  const sub = stage.subCategory;
  const subCategory =
    sub && category === "카페" ? (OLD_SUB_CATEGORY_NAMES[sub] ?? sub) : sub;
  return { ...stage, category, subCategory };
}

/** "상관없음" 상태의 코스 시작지 장소(아직 장소를 고르지 않음). 추천 계산에는 넣지 않는다. */
const DEFAULT_ORIGIN_PLACE_ID = "default-origin";

function isUnsetStage(stage: Stage): boolean {
  return (
    stage.kind === "designated" && stage.place.id === DEFAULT_ORIGIN_PLACE_ID
  );
}

/**
 * AI가 테마와 장소를 채워 줄 "상관없음" 칸.
 * 코스 시작지의 "상관없음"은 다른 단계가 하나라도 있을 때만 칸으로 센다(없으면 AI가 일정을 통으로 짠다).
 */
function isFillSlot(stage: Stage, all: Stage[]): boolean {
  if (!isUnsetStage(stage)) return false;
  return !stage.isOrigin || all.some((s) => !s.isOrigin);
}

/** AI에게 알려 줄 단계 이름. 추천 단계는 카테고리(+세부), 지정 단계는 장소 이름. */
function describeStageForAi(stage: Stage): string {
  if (stage.kind === "recommend") {
    return stageLabel(stage.category, stage.subCategory, stage.note);
  }
  return stage.isOrigin ? `코스 시작지: ${stage.place.name}` : stage.place.name;
}

/** 장소를 아직 고르지 않은 "상관없음" 지정 단계(코스 시작지 기본값, 단계 추가의 "상관없음")를 만든다. */
function unsetPlace(): DesignatedPlace {
  return {
    id: DEFAULT_ORIGIN_PLACE_ID,
    name: "상관없음",
    address: "",
    lat: REGION_CENTER.lat,
    lng: REGION_CENTER.lng,
  };
}

/** 일정 맨 앞에 코스 시작지 단계가 항상 하나 있도록 맞춘다(없으면 "상관없음" 코스 시작지를 앞에 넣고, 여러 개면 첫 번째만 남긴다). */
function ensureOriginStage(stages: Stage[]): Stage[] {
  const origin = stages.find((s) => s.isOrigin);
  const rest = stages.filter((s) => !s.isOrigin);
  return [
    origin ?? {
      id: generateId("stage"),
      kind: "designated" as const,
      isOrigin: true,
      place: unsetPlace(),
    },
    ...rest,
  ];
}

function dedupeStageIds(stages: Stage[]): Stage[] {
  // 과거 버전의 id 생성 방식 때문에 localStorage에 이미 중복된 id로 저장된
  // 일정이 있을 수 있어, 불러올 때 중복분만 새 id로 바꿔준다.
  const seen = new Set<string>();
  return stages.map((raw) => {
    // 예전에 "전시"로 저장된 추천 단계는 "문화 생활"로 옮긴다.
    const stage = migrateStage(raw);
    if (!seen.has(stage.id)) {
      seen.add(stage.id);
      return stage;
    }
    const id = generateId("stage");
    seen.add(id);
    return { ...stage, id };
  });
}

function loadLastInput(): { stages: Stage[]; maxTravelMinutes: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_INPUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed.stages) ||
      typeof parsed.maxTravelMinutes !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveLastInput(stages: Stage[], maxTravelMinutes: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LAST_INPUT_STORAGE_KEY,
      JSON.stringify({ stages, maxTravelMinutes }),
    );
  } catch {
    // 저장 실패(용량 초과 등)는 무시한다.
  }
}

function loadRecentDesignated(): DesignatedPlace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_DESIGNATED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 예전 버전이 같은 id로 저장한 항목이 있어도 목록 키가 겹치지 않게 id 기준으로 한 번 거른다.
    const seen = new Set<string>();
    return (parsed as DesignatedPlace[]).filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  } catch {
    return [];
  }
}

function saveRecentDesignated(list: DesignatedPlace[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_DESIGNATED_STORAGE_KEY,
      JSON.stringify(list),
    );
  } catch {
    // 무시
  }
}

/** 오늘 날짜를 기기 시간대 기준 "YYYY-MM-DD"로 돌려준다 (날짜 입력칸이 쓰는 형식). */
function todayString(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** 저장해둔 일정 날짜를 불러온다. 없거나 이미 지난 날짜면 오늘로 대신한다. */
function loadPlanDate(): string {
  const today = todayString();
  try {
    const saved = window.localStorage.getItem(PLAN_DATE_STORAGE_KEY);
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) && saved >= today)
      return saved;
  } catch {
    // 저장소를 못 읽으면 오늘로 둔다.
  }
  return today;
}

/** 0~30시를 화면 문구로. 24시 이후는 "다음날 …"로 보여준다. 예: 14 → 오후 2시, 26 → 다음날 오전 2시 */
function hourLabel(hour: number): string {
  const day = hour >= 24 ? "다음날 " : "";
  const h = hour % 24;
  if (h === 0) return `${day}자정`;
  if (h === 12) return `${day}낮 12시`;
  return `${day}${h < 12 ? "오전" : "오후"} ${h % 12}시`;
}

function loadMeetTimes(): { start: number | null; end: number | null } {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(MEET_TIMES_STORAGE_KEY) ?? "null",
    );
    if (parsed && typeof parsed === "object") {
      const { start, end } = parsed as { start?: unknown; end?: unknown };
      const s =
        typeof start === "number" && start >= 0 && start <= 23 ? start : null;
      const e =
        typeof end === "number" &&
        end >= 1 &&
        end <= MAX_END_HOUR &&
        (s === null || end > s)
          ? end
          : null;
      return { start: s, end: e };
    }
  } catch {
    // 저장소를 못 읽거나 형식이 틀리면 "상관없음"으로 둔다.
  }
  return { start: null, end: null };
}

function CourseBuilder() {
  const [selection, setSelection] =
    useState<RegionSelection>(DEFAULT_SELECTION);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const regions = useMemo(() => selectionRegions(selection), [selection]);
  // 장소 후보를 가져올 때마다 올라가서, 가져온 장소로 코스를 다시 계산하게 한다.
  const liveVersion = useSyncExternalStore(
    subscribeLivePlaces,
    livePlacesVersion,
    () => 0,
  );
  const loadingPlaces = useSyncExternalStore(
    subscribeLivePlaces,
    isLoadingLive,
    () => false,
  );

  useEffect(() => {
    // 저장된 지역은 브라우저에서만 읽을 수 있어 마운트 후 한 번 읽는다.
    try {
      const raw = window.localStorage.getItem(REGIONS_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setSelection(resolveSelection(JSON.parse(raw)));
    } catch {
      // 못 읽으면 기본 지역(서울·종로)으로 둔다.
    }
    setRegionsLoaded(true);
  }, []);

  useEffect(() => {
    if (!regionsLoaded) return;
    try {
      window.localStorage.setItem(
        REGIONS_STORAGE_KEY,
        JSON.stringify(selection),
      );
    } catch {
      // 저장에 실패해도 이번 화면에서는 고른 지역이 유지된다.
    }
  }, [selection, regionsLoaded]);

  const regionValue = useMemo<RegionContextValue>(
    () => ({
      regions,
      center: { lat: regions[0].lat, lng: regions[0].lng },
      loadingPlaces,
    }),
    [regions, loadingPlaces],
  );

  return (
    <RegionContext.Provider value={regionValue}>
      <CourseBuilderBody
        regions={regions}
        selection={selection}
        regionsLoaded={regionsLoaded}
        liveVersion={liveVersion}
        onChangeSelection={setSelection}
      />
    </RegionContext.Provider>
  );
}

function CourseBuilderBody({
  regions,
  selection,
  regionsLoaded,
  liveVersion,
  onChangeSelection,
}: {
  regions: Region[];
  selection: RegionSelection;
  regionsLoaded: boolean;
  liveVersion: number;
  onChangeSelection: (selection: RegionSelection) => void;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [regionSheetOpen, setRegionSheetOpen] = useState(false);
  // 코스가 코스 시작 지역 밖으로도 이어지므로 모든 카테고리를 후보로 본다.
  const allCategories = true;
  const regionNames = useMemo(() => regions.map((r) => r.name), [regions]);
  const pool = useMemo(
    () => buildPool(regions),
    // liveVersion: 후보를 새로 가져오면 장소 목록을 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regions, liveVersion],
  );
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(
    DEFAULT_TRAVEL_MINUTES,
  );
  // 화면에는 maxTravelMinutes(0이면 상관 없음)를 보여 주고, 계산에는 travelLimit을 쓴다.
  const travelLimit =
    maxTravelMinutes === UNLIMITED_TRAVEL
      ? UNLIMITED_TRAVEL_LIMIT_MINUTES
      : maxTravelMinutes;
  const [planDate, setPlanDate] = useState("");
  const [themeNote, setThemeNote] = useState("");
  const [startHour, setStartHour] = useState<number | null>(null);
  const [endHour, setEndHour] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [overrides, setOverrides] = useState<StageOverrides>({});
  // AI에게 코스를 물어보는 중인지, 그리고 실패했을 때 잠깐 띄울 안내 문구.
  const [makingCourse, setMakingCourse] = useState(false);
  // 결과 화면에서 "상관없음" 칸을 AI가 채우는 동안 true.
  const [fillingSlots, setFillingSlots] = useState(false);
  // "코스 만들기"를 누른 순간의 입력(일정 단계). 결과 화면에서 돌아가면 이 상태로 되돌린다.
  const inputSnapshotRef = useRef<Stage[] | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // 일정 칸의 "변경"을 누르면 단계 추가와 같은 창이 뜨고, 고른 것으로 그 칸이 바뀐다. 바꿀 칸의 id.
  const [changeStageTarget, setChangeStageTarget] = useState<string | null>(
    null,
  );
  const [designatedEditTarget, setDesignatedEditTarget] = useState<
    string | "new" | null
  >(null);
  const [recentDesignated, setRecentDesignated] = useState<DesignatedPlace[]>(
    [],
  );

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [navigating, setNavigating] = useState(false);
  const [groupScreenOpen, setGroupScreenOpen] = useState(false);
  // 로그인 직후에는 아바타 홈 화면만 보이고, "코스 추천 받기"를 누르면 코스 만들기 창으로 넘어간다.
  const [onHome, setOnHome] = useState(true);

  useEffect(() => {
    // 위치 정보는 브라우저(외부 시스템)에서 비동기로 받아오므로 결과를
    // 콜백에서 상태에 반영한다. 마운트 후 한 번만 요청한다.
    if (!("geolocation" in navigator)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocationStatus("unsupported");
      return;
    }
    setLocationStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationStatus("granted");
      },
      () => setLocationStatus("denied"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  useEffect(() => {
    // 동선 진행 화면에서는 실시간 위치 공유를 흉내내어 위치를 계속 갱신한다.
    if (!navigating || !("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationStatus("granted");
      },
      () => setLocationStatus("denied"),
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [navigating]);

  const avatarPoint = location ?? { lat: regions[0].lat, lng: regions[0].lng };

  useEffect(() => {
    // localStorage는 서버에 없는 브라우저 전용 저장소라 마운트 후에만 읽을 수 있다.
    // 초기 렌더와 다른 값이 돼도 안전하므로(사용자 입력을 기억해두는 용도일 뿐)
    // 여기서 한 번만 읽어 상태에 반영한다.
    const last = loadLastInput();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStages(ensureOriginStage(last ? dedupeStageIds(last.stages) : []));
    setMaxTravelMinutes(
      last ? snapTravelMinutes(last.maxTravelMinutes) : DEFAULT_TRAVEL_MINUTES,
    );
    setRecentDesignated(loadRecentDesignated());
    setPlanDate(loadPlanDate());
    try {
      setThemeNote(
        (window.localStorage.getItem(THEME_NOTE_STORAGE_KEY) ?? "").slice(
          0,
          MAX_THEME_NOTE_LENGTH,
        ),
      );
    } catch {
      // 저장소를 못 읽으면 빈 칸으로 둔다.
    }
    const meet = loadMeetTimes();
    setStartHour(meet.start);
    setEndHour(meet.end);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLastInput(stages, maxTravelMinutes);
  }, [stages, maxTravelMinutes, hydrated]);

  useEffect(() => {
    if (!hydrated || !planDate) return;
    try {
      window.localStorage.setItem(PLAN_DATE_STORAGE_KEY, planDate);
    } catch {
      // 저장에 실패해도 이번 화면에서는 선택한 날짜가 유지된다.
    }
  }, [planDate, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(THEME_NOTE_STORAGE_KEY, themeNote);
    } catch {
      // 저장에 실패해도 이번 화면에서는 적은 내용이 유지된다.
    }
  }, [themeNote, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        MEET_TIMES_STORAGE_KEY,
        JSON.stringify({ start: startHour, end: endHour }),
      );
    } catch {
      // 저장에 실패해도 이번 화면에서는 고른 시간이 유지된다.
    }
  }, [startHour, endHour, hydrated]);

  /** 만나는 시간을 바꿨을 때, 헤어지는 시간이 그보다 같거나 빠르면 "상관없음"으로 되돌린다. */
  function changeStartHour(hour: number | null) {
    setStartHour(hour);
    if (hour !== null && endHour !== null && endHour <= hour) setEndHour(null);
  }

  const result = useMemo(
    () =>
      buildCourse(
        stages.filter((s) => !isUnsetStage(s)),
        pool,
        travelLimit,
        overrides,
        planDate,
      ),
    [stages, pool, travelLimit, overrides, planDate],
  );

  // 일정·코스 시작 지역·이동시간이 바뀔 때마다 필요한 장소 후보(직전 장소 주변)를 미리 가져온다.
  useEffect(() => {
    if (!regionsLoaded || !hydrated) return;
    void loadLivePlacesForCourse({
      stages: stages.filter((s) => !isUnsetStage(s)),
      starts: regions,
      maxTravelMinutes: travelLimit,
      overrides,
      planDate,
      samples: includesSampleRegion(regions) ? places : [],
    });
  }, [
    regionsLoaded,
    hydrated,
    stages,
    regions,
    travelLimit,
    overrides,
    planDate,
  ]);

  function addRecommendStage(
    category: PlaceCategory,
    subCategory: string | undefined,
    note?: string,
    keywords?: string[],
  ) {
    setStages((prev) => [
      ...prev,
      {
        id: generateId("stage"),
        kind: "recommend",
        category,
        subCategory,
        note,
        keywords,
      },
    ]);
    setAddSheetOpen(false);
  }

  /** 사용자가 적은 장소 유형을 AI가 카테고리로 바꿔 준다. 못 알아내거나 AI가 실패하면 null. */
  async function resolveTypedStage(
    typeNote: string,
  ): Promise<TypedStage | null> {
    try {
      const data = await postRecommend<{
        stage?: TypedStage | null;
      }>({ mode: "stageType", typeNote, regionNames, allCategories });
      return data.stage ?? null;
    } catch {
      return null;
    }
  }

  function addUnsetDesignatedStage() {
    const next: Stage[] = [
      ...stages,
      { id: generateId("stage"), kind: "designated", place: unsetPlace() },
    ];
    setStages(next);
    setAddSheetOpen(false);
    // 결과 화면에서 추가한 "상관없음" 칸은 바로 AI가 채운다.
    if (showResult) void fillSlotsOnResult(next);
  }

  function upsertDesignatedStage(place: DesignatedPlace) {
    setStages((prev) => {
      if (designatedEditTarget && designatedEditTarget !== "new") {
        // 추천 단계였던 칸도 장소를 직접 고르면 지정 단계로 바뀐다(코스 시작지 표시는 유지).
        return prev.map((s) =>
          s.id === designatedEditTarget
            ? {
                id: s.id,
                kind: "designated" as const,
                place,
                isOrigin: s.isOrigin,
              }
            : s,
        );
      }
      return [
        ...prev,
        { id: generateId("stage"), kind: "designated" as const, place },
      ];
    });
    // 현재 위치·지도에서 고른 위치는 매번 달라지므로 "최근 지정 장소"에는 남기지 않는다.
    if (
      place.id !== CURRENT_LOCATION_PLACE_ID &&
      place.id !== MAP_PICK_PLACE_ID
    )
      setRecentDesignated((prev) => {
        const deduped = prev.filter(
          (p) =>
            p.id !== place.id &&
            !(p.name === place.name && p.address === place.address),
        );
        const next = [place, ...deduped].slice(0, MAX_RECENT_DESIGNATED);
        saveRecentDesignated(next);
        return next;
      });
    setOverrides({}); // 지정 장소가 바뀌면 주변 추천 단계를 다시 계산한다.
    setDesignatedEditTarget(null);
    setAddSheetOpen(false);
  }

  function removeStage(id: string) {
    setStages((prev) => prev.filter((s) => s.id !== id || s.isOrigin));
  }

  /**
   * 결과 화면에서 입력 화면으로 돌아간다. 결과 화면에서 바꾼 것(순서·코스 시작지·삭제·추가)과
   * AI가 채운 칸은 모두 버리고, "코스 만들기"를 누르던 때의 입력 상태로 되돌린다.
   */
  function leaveResult() {
    setShowResult(false);
    const snapshot = inputSnapshotRef.current;
    if (!snapshot) return;
    inputSnapshotRef.current = null;
    setStages(snapshot);
    setOverrides({});
  }

  /** 결과 화면에서 단계를 지운다(코스 시작지도 가능, 지우면 다음 단계가 코스 시작지가 됨). 남은 단계가 없으면 입력 화면으로 돌아간다. */
  function removeStageFromResult(id: string) {
    const remaining = stages.filter((s) => s.id !== id && !isUnsetStage(s));
    setStages((prev) =>
      prev
        .filter((s) => s.id !== id)
        .map((s, i) => ({ ...s, isOrigin: i === 0 })),
    );
    if (remaining.length === 0) leaveResult();
  }

  async function postRecommend<T>(body: unknown): Promise<T> {
    const res = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("ai-failed");
    return (await res.json()) as T;
  }

  function showAiMessage(message: string) {
    setAiMessage(message);
    window.setTimeout(() => setAiMessage(null), 4000);
  }

  /**
   * "상관없음" 칸을 AI가 정한 테마(카테고리)로 채운 새 단계 목록을 돌려준다(칸의 id는 그대로).
   * 칸이 없으면 그대로, AI가 실패하거나 칸 수가 맞지 않으면 null.
   */
  async function fillSlots(
    list: Stage[],
    aiInput: {
      themeNote: string;
      startHour: number | null;
      endHour: number | null;
      planDate?: string;
      regionNames: string[];
      allCategories: boolean;
    },
  ): Promise<Stage[] | null> {
    const isSlot = (s: Stage) => isFillSlot(s, list);
    if (!list.some(isSlot)) return list;
    const slotCount = list.filter(isSlot).length;
    try {
      const data = await postRecommend<{
        stages?: { category: PlaceCategory; subCategory?: string }[];
      }>({
        mode: "fill",
        ...aiInput,
        stages: list
          .filter((s) => !(isUnsetStage(s) && !isSlot(s)))
          .map((s) => ({
            label: isSlot(s) ? null : describeStageForAi(s),
          })),
      });
      const filled = data.stages ?? [];
      if (filled.length !== slotCount) return null;
      let i = 0;
      return list.map((s) => {
        if (!isSlot(s)) return s;
        const f = filled[i++];
        return {
          id: s.id,
          kind: "recommend" as const,
          category: f.category,
          subCategory: f.subCategory,
          isOrigin: s.isOrigin,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * 결과 화면에서 "상관없음" 칸이 생겼을 때: AI가 테마를 정해 채우고, 그 칸의 장소도 고른다.
   * 실패하면 빈 칸은 지워서(보이지 않는 칸이 남지 않게) 안내만 띄운다.
   */
  async function fillSlotsOnResult(next: Stage[]) {
    setFillingSlots(true);
    try {
      const aiInput = {
        themeNote,
        startHour,
        endHour,
        planDate: planDate || undefined,
        regionNames,
        allCategories,
      };
      const filled = await fillSlots(next, aiInput);
      if (!filled) {
        setStages((prev) =>
          prev.filter((s) => s.isOrigin || !isFillSlot(s, prev)),
        );
        showAiMessage(
          "AI가 상관없음 칸을 채우지 못했어요. 다시 시도해 주세요.",
        );
        return;
      }
      const newIds = new Set(
        next.filter((s) => isFillSlot(s, next)).map((s) => s.id),
      );
      setStages((prev) =>
        prev.map(
          (s) => filled.find((f) => f.id === s.id && newIds.has(s.id)) ?? s,
        ),
      );
      try {
        await loadLivePlacesForCourse({
          stages: filled.filter((s) => !isUnsetStage(s)),
          starts: regions,
          maxTravelMinutes: travelLimit,
          overrides,
          planDate,
          samples: includesSampleRegion(regions) ? places : [],
        });
        const baseline = buildCourse(
          filled.filter((s) => !isUnsetStage(s)),
          buildPool(regions),
          travelLimit,
          overrides,
          planDate,
        );
        const data = await postRecommend<{ picks?: AiPicks }>(
          buildAiRequest(baseline, aiInput),
        );
        const added = Object.fromEntries(
          Object.entries(data.picks ?? {}).filter(([id]) => newIds.has(id)),
        );
        if (Object.keys(added).length > 0) {
          setOverrides((prev) => ({ ...prev, ...added }));
        }
      } catch {
        // 장소 고르기만 실패하면 기본 추천(평점·거리)으로 둔다.
      }
    } finally {
      setFillingSlots(false);
    }
  }

  /**
   * - 일정 단계가 하나도 없으면: AI가 분위기 글·시간으로 단계부터 짜고, 그 단계에 맞는 장소도 고른다.
   *   AI가 실패하면 결과로 넘어가지 않고 안내만 띄운다(보여줄 단계가 없으므로).
   * - 단계가 있고 분위기 글·시간 중 하나라도 있으면: AI가 기본 추천 후보 중에서 장소를 고른다.
   *   실패하면 기본 추천(평점·거리 점수)으로 보여준다.
   */
  async function makeCourse(options: { originOnly?: boolean } = {}) {
    inputSnapshotRef.current = stages;
    setOverrides({});
    const aiInput = {
      themeNote,
      startHour,
      endHour,
      planDate: planDate || undefined,
      regionNames,
      allCategories,
    };
    // 코스 시작지 말고는 단계가 하나도 없을 때만 AI가 단계 수까지 정한다("상관없음" 칸은 칸으로 센다).
    // 코스 시작지만 추천받기로 한 경우(originOnly)에는 뒤 일정을 짜지 않는다.
    const needsPlan = !options.originOnly && !stages.some((s) => !s.isOrigin);
    const hasSlots = stages.some((s) => isFillSlot(s, stages));
    const wantsAi =
      needsPlan ||
      hasSlots ||
      themeNote.trim().length > 0 ||
      startHour !== null ||
      endHour !== null;
    let working = stages.filter((s) => !isUnsetStage(s));
    let plannedStages: Stage[] | null = null;
    let filledStages: Stage[] | null = null;
    if (
      !wantsAi ||
      (!needsPlan && !hasSlots && !working.some((s) => s.kind === "recommend"))
    ) {
      setShowResult(true);
      return;
    }

    setMakingCourse(true);
    setAiMessage(null);
    try {
      if (needsPlan) {
        let planned: { category: PlaceCategory; subCategory?: string }[];
        try {
          const data = await postRecommend<{
            stages?: { category: PlaceCategory; subCategory?: string }[];
          }>({ mode: "plan", ...aiInput });
          planned = data.stages ?? [];
          if (planned.length === 0) throw new Error("plan-empty");
        } catch {
          showAiMessage(
            "AI가 단계를 짜지 못했어요. 단계를 직접 추가해 보세요.",
          );
          return;
        }
        const newStages: Stage[] = planned
          .slice(0, MAX_STAGES - 1)
          .map((p) => ({
            id: generateId("stage"),
            kind: "recommend" as const,
            category: p.category,
            subCategory: p.subCategory,
          }));
        // 코스 시작지는 그대로 두고, 이어서 AI가 짠 단계를 붙인다(비어 있던 지정 단계는 대체).
        // 입력 화면에 단계가 비쳐 보이지 않도록, 결과 화면으로 넘어가는 순간에 함께 반영한다.
        plannedStages = newStages;
        working = [...stages.filter((s) => s.isOrigin), ...newStages].filter(
          (s) => !isUnsetStage(s),
        );
      }

      if (!needsPlan && hasSlots) {
        const filled = await fillSlots(stages, aiInput);
        if (filled) {
          filledStages = filled;
          working = filled.filter((s) => !isUnsetStage(s));
        } else {
          showAiMessage(
            "AI가 상관없음 칸을 채우지 못해 그 칸은 빼고 보여드려요.",
          );
          if (!working.some((s) => !s.isOrigin)) return;
        }
      }

      try {
        await loadLivePlacesForCourse({
          stages: working,
          starts: regions,
          maxTravelMinutes: travelLimit,
          overrides: {},
          planDate,
          samples: includesSampleRegion(regions) ? places : [],
        });
        const baseline = buildCourse(
          working,
          buildPool(regions),
          travelLimit,
          {},
          planDate,
        );
        const data = await postRecommend<{ picks?: AiPicks }>(
          buildAiRequest(baseline, aiInput),
        );
        const picks = data.picks ?? {};
        if (Object.keys(picks).length === 0) throw new Error("ai-empty");
        setOverrides(picks);
      } catch {
        showAiMessage("AI 추천을 불러오지 못해 기본 추천으로 보여드려요.");
      }
      if (plannedStages) {
        const added = plannedStages;
        setStages((prev) => [...prev.filter((s) => s.isOrigin), ...added]);
      }
      if (filledStages) {
        const byId = new Map(filledStages.map((s) => [s.id, s]));
        setStages((prev) => prev.map((s) => byId.get(s.id) ?? s));
      }
      setShowResult(true);
    } finally {
      setMakingCourse(false);
    }
  }

  /** 코스 만들기 화면의 일정 단계만 처음 상태(코스 시작지 "상관없음" 하나)로 되돌린다. 날짜·시간·분위기 글·이동시간은 그대로 둔다. */
  function resetStages() {
    setStages(ensureOriginStage([]));
    setOverrides({});
  }

  /** 결과 화면에서 끌어 바꾼 순서를 일정 단계에 반영한다. 맨 위에 온 단계가 코스 시작지가 된다. */
  function reorderStagesById(orderedIds: string[]) {
    setStages((prev) => {
      const moved = orderedIds
        .map((id) => prev.find((s) => s.id === id))
        .filter((s): s is Stage => s !== undefined);
      const rest = prev.filter((s) => !orderedIds.includes(s.id));
      return [...moved, ...rest].map((s, i) => ({ ...s, isOrigin: i === 0 }));
    });
  }

  function replaceRecommendStage(stageId: string, placeId: string) {
    setOverrides((prev) => ({ ...prev, [stageId]: placeId }));
  }

  const editingPlace =
    designatedEditTarget && designatedEditTarget !== "new"
      ? stages.find(
          (s) => s.id === designatedEditTarget && s.kind === "designated",
        )
      : null;

  if (groupScreenOpen) {
    return <GroupView onBack={() => setGroupScreenOpen(false)} />;
  }

  if (navigating) {
    return (
      <NavigateView
        result={result}
        avatarPoint={avatarPoint}
        locationKnown={location !== null}
        onBack={() => setNavigating(false)}
        onEnd={() => {
          setNavigating(false);
          leaveResult();
        }}
      />
    );
  }

  return (
    <>
      {showResult ? (
        <ResultView
          result={result}
          avatarPoint={avatarPoint}
          onBack={leaveResult}
          onReplace={replaceRecommendStage}
          onReorderStages={reorderStagesById}
          onRequestChangeTheme={setChangeStageTarget}
          onRemoveStage={removeStageFromResult}
          onAddStage={() => setAddSheetOpen(true)}
          onDecideRoute={() => setNavigating(true)}
        />
      ) : onHome ? (
        <div className="relative h-screen w-full bg-white dark:bg-black">
          <AvatarScene
            status={locationStatus}
            onOpenGroup={() => setGroupScreenOpen(true)}
          />
          <button
            type="button"
            onClick={() => setOnHome(false)}
            className="absolute bottom-8 left-1/2 h-14 -translate-x-1/2 rounded-full bg-black px-8 text-base font-semibold text-white shadow-lg dark:bg-white dark:text-black"
          >
            코스 추천 받기
          </button>
        </div>
      ) : (
        <div className="h-screen w-full overflow-hidden bg-white dark:bg-black">
          <InputView
            stages={stages}
            planDate={planDate}
            onSetPlanDate={setPlanDate}
            startHour={startHour}
            endHour={endHour}
            onSetStartHour={changeStartHour}
            onSetEndHour={setEndHour}
            themeNote={themeNote}
            onSetThemeNote={setThemeNote}
            maxTravelMinutes={maxTravelMinutes}
            onSetMaxTravelMinutes={setMaxTravelMinutes}
            onOpenAddSheet={() => setAddSheetOpen(true)}
            onRemoveStage={removeStage}
            onReorderStages={setStages}
            onRequestChangeDesignated={(stageId) =>
              setChangeStageTarget(stageId)
            }
            onMakeCourse={makeCourse}
            makingCourse={makingCourse}
            onBackToHome={() => setOnHome(true)}
            onReset={resetStages}
            regions={regions}
            onOpenRegionSheet={() => setRegionSheetOpen(true)}
          />
        </div>
      )}

      {fillingSlots && (
        <div
          role="status"
          className="fixed inset-x-4 top-4 z-50 mx-auto max-w-md rounded-xl bg-zinc-900 px-4 py-3 text-center text-sm text-white shadow-lg dark:bg-white dark:text-black"
        >
          AI가 상관없음 칸을 채우는 중…
        </div>
      )}

      {aiMessage && (
        <div
          role="status"
          className="fixed inset-x-4 top-4 z-50 mx-auto max-w-md rounded-xl bg-amber-100 px-4 py-3 text-center text-sm text-amber-900 shadow-lg dark:bg-amber-900 dark:text-amber-100"
        >
          {aiMessage}
        </div>
      )}

      {regionSheetOpen && (
        <RegionSheet
          selected={selection}
          onClose={() => setRegionSheetOpen(false)}
          onApply={(next) => {
            onChangeSelection(next);
            setOverrides({}); // 지역이 바뀌면 추천을 새로 계산한다.
            setRegionSheetOpen(false);
          }}
        />
      )}

      {addSheetOpen && (
        <AddStageSheet
          canAddMore={stages.length < MAX_STAGES}
          onClose={() => setAddSheetOpen(false)}
          onAddRecommend={addRecommendStage}
          onResolveTyped={resolveTypedStage}
          onAddUnsetDesignated={addUnsetDesignatedStage}
          onStartDesignated={() => setDesignatedEditTarget("new")}
        />
      )}

      {changeStageTarget && (
        <AddStageSheet
          title="단계 변경"
          canAddMore
          onClose={() => setChangeStageTarget(null)}
          onResolveTyped={resolveTypedStage}
          onAddRecommend={(category, subCategory, note, keywords) => {
            setStages((prev) =>
              prev.map((s) =>
                s.id === changeStageTarget
                  ? {
                      id: generateId("stage"),
                      kind: "recommend" as const,
                      category,
                      subCategory,
                      note,
                      keywords,
                      isOrigin: s.isOrigin,
                    }
                  : s,
              ),
            );
            setChangeStageTarget(null);
          }}
          onAddUnsetDesignated={() => {
            const next: Stage[] = stages.map((s) =>
              s.id !== changeStageTarget
                ? s
                : s.kind === "designated"
                  ? { ...s, place: unsetPlace() }
                  : {
                      id: s.id,
                      kind: "designated" as const,
                      place: unsetPlace(),
                      isOrigin: s.isOrigin,
                    },
            );
            setStages(next);
            setOverrides({});
            setChangeStageTarget(null);
            if (showResult) void fillSlotsOnResult(next);
          }}
          onStartDesignated={() => {
            setDesignatedEditTarget(changeStageTarget);
            setChangeStageTarget(null);
          }}
        />
      )}

      {designatedEditTarget && (
        <DesignatedPlaceSheet
          initial={
            editingPlace &&
            editingPlace.kind === "designated" &&
            !isUnsetStage(editingPlace)
              ? editingPlace.place
              : null
          }
          recentPlaces={recentDesignated}
          currentLocation={location}
          locationStatus={locationStatus}
          onClose={() => setDesignatedEditTarget(null)}
          onSubmit={upsertDesignatedStage}
        />
      )}
    </>
  );
}

function InputView({
  planDate,
  onSetPlanDate,
  startHour,
  endHour,
  onSetStartHour,
  onSetEndHour,
  themeNote,
  onSetThemeNote,
  stages,
  maxTravelMinutes,
  onSetMaxTravelMinutes,
  onOpenAddSheet,
  onRemoveStage,
  onReorderStages,
  onRequestChangeDesignated,
  onMakeCourse,
  makingCourse,
  onBackToHome,
  onReset,
  regions,
  onOpenRegionSheet,
}: {
  regions: Region[];
  onOpenRegionSheet: () => void;
  planDate: string;
  onSetPlanDate: (date: string) => void;
  startHour: number | null;
  endHour: number | null;
  onSetStartHour: (hour: number | null) => void;
  onSetEndHour: (hour: number | null) => void;
  themeNote: string;
  onSetThemeNote: (note: string) => void;
  stages: Stage[];
  maxTravelMinutes: number;
  onSetMaxTravelMinutes: (minutes: number) => void;
  onOpenAddSheet: () => void;
  onRemoveStage: (id: string) => void;
  onReorderStages: (stages: Stage[]) => void;
  onRequestChangeDesignated: (stageId: string) => void;
  onMakeCourse: (options?: { originOnly?: boolean }) => void;
  makingCourse: boolean;
  onBackToHome: () => void;
  onReset: () => void;
}) {
  const [travelPickerOpen, setTravelPickerOpen] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [timePicker, setTimePicker] = useState<"start" | "end" | null>(null);
  const hasNote = themeNote.trim().length > 0;
  const travelText =
    maxTravelMinutes === UNLIMITED_TRAVEL
      ? "상관 없음"
      : `${maxTravelMinutes}분`;

  // 단계가 없으면 AI가 단계부터 짜 주고, 있으면 그 단계로 코스를 만든다.
  const origin = stages.find((s) => s.isOrigin);
  const others = stages.filter((s) => !s.isOrigin);
  const hasOthers = others.some((s) => !isUnsetStage(s));
  const makeLabel = hasOthers
    ? "코스 만들기"
    : hasNote
      ? "이 분위기로 코스 추천받기"
      : "AI에게 코스 추천받기";

  // 코스 시작지 칸만 있고 그 칸이 테마나 장소로 채워져 있으면, 코스 시작지만 추천할지 먼저 묻는다.
  const [askOriginOnly, setAskOriginOnly] = useState(false);
  const onlyFilledOrigin =
    origin !== undefined && others.length === 0 && !isUnsetStage(origin);

  function onPressMake() {
    if (onlyFilledOrigin) {
      setAskOriginOnly(true);
      return;
    }
    onMakeCourse();
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto bg-white px-4 pt-6 dark:bg-black">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBackToHome}
          aria-label="아바타 홈으로"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-300 text-lg dark:border-zinc-700 dark:text-white"
        >
          ←
        </button>
        <h1 className="text-2xl font-bold text-black dark:text-white">
          코스 만들기
        </h1>
      </div>

      <div className="flex gap-3">
        <section className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            코스 시작 지역
          </label>
          <button
            type="button"
            onClick={onOpenRegionSheet}
            aria-label={`코스 시작 지역 선택: ${regionLabel(regions[0])}`}
            className="flex h-12 w-full items-center justify-between gap-2 rounded-xl border border-zinc-300 bg-zinc-50 px-4 text-left text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          >
            <span className="min-w-0 truncate">{regionLabel(regions[0])}</span>
            <span aria-hidden className="shrink-0 text-xs text-zinc-500">
              ▾
            </span>
          </button>
        </section>

        <section className="flex min-w-0 flex-1 flex-col gap-2">
          <label
            htmlFor="plan-date"
            className="text-sm font-medium text-zinc-600 dark:text-zinc-400"
          >
            일정 날짜
          </label>
          <input
            id="plan-date"
            type="date"
            value={planDate}
            min={todayString()}
            onChange={(e) => {
              if (e.target.value) onSetPlanDate(e.target.value);
            }}
            className="h-12 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:[color-scheme:dark]"
          />
        </section>
      </div>

      <div className="flex gap-3">
        {(
          [
            ["start", "만나는 시간", startHour],
            ["end", "헤어지는 시간", endHour],
          ] as const
        ).map(([which, label, hour]) => (
          <section key={which} className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              {label}
            </span>
            <button
              type="button"
              onClick={() => setTimePicker(which)}
              aria-label={`${label} ${hour === null ? "상관없음" : hourLabel(hour)}, 눌러서 바꾸기`}
              className="flex h-12 w-full items-center justify-between gap-1 rounded-xl border border-zinc-300 bg-white px-3 text-left text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
            >
              <span
                className={`truncate ${hour === null ? "text-zinc-500 dark:text-zinc-400" : ""}`}
              >
                {hour === null ? "상관없음" : hourLabel(hour)}
              </span>
              <span aria-hidden className="shrink-0 text-zinc-500">
                ▾
              </span>
            </button>
          </section>
        ))}
      </div>

      {timePicker && (
        <TimePickerSheet
          title={timePicker === "start" ? "만나는 시간" : "헤어지는 시간"}
          value={timePicker === "start" ? startHour : endHour}
          withDay={timePicker === "end"}
          minExclusive={timePicker === "end" ? startHour : null}
          onConfirm={(hour) => {
            if (timePicker === "start") onSetStartHour(hour);
            else onSetEndHour(hour);
            setTimePicker(null);
          }}
          onClose={() => setTimePicker(null)}
        />
      )}

      <section className="flex flex-col gap-2">
        <label
          htmlFor="theme-note"
          className="flex items-center justify-between text-sm font-medium text-zinc-600 dark:text-zinc-400"
        >
          <span>
            어떤 하루를 보내고 싶으신가요?{" "}
            <span className="font-normal text-zinc-400 dark:text-zinc-500">
              (비워둬도 돼요)
            </span>
          </span>
          <span className="text-xs font-normal text-zinc-400 dark:text-zinc-500">
            {themeNote.length}/{MAX_THEME_NOTE_LENGTH}
          </span>
        </label>
        <textarea
          id="theme-note"
          value={themeNote}
          onChange={(e) => onSetThemeNote(e.target.value)}
          maxLength={MAX_THEME_NOTE_LENGTH}
          rows={2}
          placeholder="예: 조용하고 감성적인 분위기, 전시 보고 한옥 카페에서 쉬고 싶어요"
          className="w-full resize-none rounded-xl border border-zinc-300 bg-white px-3 py-3 text-base text-black placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder:text-zinc-500"
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            일정 단계
          </span>
          <HelpTip label="일정 단계 설명">
            <ul className="flex list-none flex-col gap-1.5">
              <li>• 가고 싶은 장소나 테마를 직접 추가할 수 있어요.</li>
              <li>
                • 코스 시작지 칸만 있고 다른 단계가 없으면, 나머지 일정은 AI가
                통째로 추천해요.
              </li>
              <li>• 왼쪽 ⠿ 버튼을 잡고 끌면 순서를 바꿀 수 있어요.</li>
              <li>• &lsquo;상관없음&rsquo;으로 두면 그 칸은 AI가 채워줘요.</li>
            </ul>
          </HelpTip>
          <button
            type="button"
            onClick={() => setAskReset(true)}
            className="ml-auto flex h-8 items-center gap-1 rounded-lg border border-zinc-300 px-2.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
          >
            <span aria-hidden>↺</span>초기화
          </button>
        </div>

        {origin && (
          <StageRow
            stage={origin}
            fixed
            onRemove={onRemoveStage}
            onRequestChangeDesignated={onRequestChangeDesignated}
          />
        )}

        <Reorder.Group
          axis="y"
          values={others}
          onReorder={(next) =>
            onReorderStages(origin ? [origin, ...next] : next)
          }
          className="flex flex-col gap-3"
        >
          {others.map((stage) => (
            <StageRow
              key={stage.id}
              stage={stage}
              onRemove={onRemoveStage}
              onRequestChangeDesignated={onRequestChangeDesignated}
            />
          ))}
        </Reorder.Group>

        {stages.length < MAX_STAGES ? (
          <button
            type="button"
            onClick={onOpenAddSheet}
            className="h-12 w-full rounded-xl border border-dashed border-zinc-400 text-base font-medium text-zinc-600 dark:border-zinc-600 dark:text-zinc-300"
          >
            + 단계 추가
          </button>
        ) : (
          <p className="text-center text-sm text-zinc-400 dark:text-zinc-500">
            최대 8단계까지 추가할 수 있어요.
          </p>
        )}
      </section>

      <section className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          구간별 최대 이동시간
        </span>
        <button
          type="button"
          onClick={() => setTravelPickerOpen(true)}
          aria-label={`구간별 최대 이동시간 ${travelText}, 눌러서 바꾸기`}
          className="flex h-11 items-center gap-1 rounded-lg border border-zinc-300 px-4 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          {travelText} <span aria-hidden>▾</span>
        </button>
      </section>

      {travelPickerOpen && (
        <ScrollPickerSheet
          title="구간별 최대 이동시간"
          testId="travel-picker"
          options={[
            ...TRAVEL_OPTIONS.map((m) => ({ value: m, label: `${m}분` })),
            { value: UNLIMITED_TRAVEL, label: "상관 없음" },
          ]}
          value={maxTravelMinutes}
          onConfirm={(minutes) => {
            onSetMaxTravelMinutes(minutes);
            setTravelPickerOpen(false);
          }}
          onClose={() => setTravelPickerOpen(false)}
        />
      )}

      {askReset && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setAskReset(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="일정 단계 초기화"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <h2 className="text-lg font-bold text-black dark:text-white">
              일정 단계를 모두 지울까요?
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              일정 단계가 처음 상태(코스 시작지 &lsquo;상관없음&rsquo; 하나)로
              돌아가요. 날짜와 시간, 분위기 글은 그대로예요.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAskReset(false)}
                className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  setAskReset(false);
                  onReset();
                }}
                className="h-12 flex-1 rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
              >
                초기화
              </button>
            </div>
          </div>
        </div>
      )}

      {askOriginOnly && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setAskOriginOnly(false)}
        >
          <div
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            aria-modal="true"
            aria-label="코스 시작지만 추천"
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-bold text-black dark:text-white">
                코스 시작지만 추천해드릴까요?
              </h2>
              <button
                type="button"
                onClick={() => setAskOriginOnly(false)}
                aria-label="닫기"
                className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              &lsquo;아니오&rsquo;를 누르면 코스 시작지 뒤의 일정도 AI가 이어서
              추천해요.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAskOriginOnly(false);
                  onMakeCourse({ originOnly: true });
                }}
                className="h-12 flex-1 rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
              >
                예
              </button>
              <button
                type="button"
                onClick={() => {
                  setAskOriginOnly(false);
                  onMakeCourse();
                }}
                className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
              >
                아니오
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 bg-white/95 px-4 pb-6 pt-3 backdrop-blur dark:bg-black/95">
        <button
          type="button"
          onClick={onPressMake}
          disabled={makingCourse}
          className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {makingCourse ? "AI가 코스를 짜는 중…" : makeLabel}
        </button>
      </div>
    </div>
  );
}

/** 제목 옆 ? 버튼. 누르면 설명이 펼쳐지고, 다시 누르면 접힌다. */
function HelpTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-xs font-semibold text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
      >
        ?
      </button>
      {open && (
        <div className="order-last basis-full rounded-lg bg-zinc-100 px-3 py-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {children}
        </div>
      )}
    </>
  );
}

const TRAVEL_PICKER_ITEM_HEIGHT = 48;
const TRAVEL_OPTIONS = Array.from(
  {
    length: (MAX_TRAVEL_MINUTES - MIN_TRAVEL_MINUTES) / TRAVEL_MINUTES_STEP + 1,
  },
  (_, i) => MIN_TRAVEL_MINUTES + i * TRAVEL_MINUTES_STEP,
);

/** 예전에 1분 단위로 저장된 값을 가장 가까운 5분 단위로 맞춘다("상관 없음"은 그대로). */
function snapTravelMinutes(minutes: number): number {
  if (minutes === UNLIMITED_TRAVEL) return UNLIMITED_TRAVEL;
  const snapped =
    Math.round(minutes / TRAVEL_MINUTES_STEP) * TRAVEL_MINUTES_STEP;
  return Math.min(Math.max(snapped, MIN_TRAVEL_MINUTES), MAX_TRAVEL_MINUTES);
}

/** 위아래로 스크롤하면 가운데 칸에 멈춘 항목이 선택되는 한 줄(바퀴). */
function WheelColumn({
  labels,
  index,
  onChange,
  testId,
}: {
  labels: string[];
  index: number;
  onChange: (index: number) => void;
  testId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [initialIndex] = useState(index);

  useEffect(() => {
    // 열릴 때 현재 값이 가운데에 오도록 한 번만 맞춘다.
    listRef.current?.scrollTo({
      top: initialIndex * TRAVEL_PICKER_ITEM_HEIGHT,
    });
  }, [initialIndex]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    const next = Math.round(el.scrollTop / TRAVEL_PICKER_ITEM_HEIGHT);
    onChange(Math.min(Math.max(next, 0), labels.length - 1));
  }

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      data-testid={testId}
      className="relative h-full min-w-0 flex-1 snap-y snap-mandatory overflow-y-scroll"
      style={{ scrollbarWidth: "none" }}
    >
      <div style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }} />
      {labels.map((label, i) => (
        <div
          key={label}
          onClick={() =>
            listRef.current?.scrollTo({
              top: i * TRAVEL_PICKER_ITEM_HEIGHT,
              behavior: "smooth",
            })
          }
          className={`flex snap-center items-center justify-center text-xl ${
            i === index
              ? "font-bold text-black dark:text-white"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
          style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }}
        >
          {label}
        </div>
      ))}
      <div style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }} />
    </div>
  );
}

/** 아래에서 올라오는 선택창의 공통 틀(제목, ✕, 바퀴를 담는 칸). */
function PickerSheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex w-full max-w-md flex-col gap-4 rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function WheelRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative flex"
      style={{ height: TRAVEL_PICKER_ITEM_HEIGHT * 3 }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 rounded-lg bg-zinc-100 dark:bg-zinc-800"
        style={{
          top: TRAVEL_PICKER_ITEM_HEIGHT,
          height: TRAVEL_PICKER_ITEM_HEIGHT,
        }}
      />
      {children}
    </div>
  );
}

/** 값을 한 줄 바퀴에서 고르는 선택창(구간별 최대 이동시간). */
function ScrollPickerSheet({
  title,
  testId,
  options,
  value,
  onConfirm,
  onClose,
}: {
  title: string;
  testId: string;
  options: { value: number; label: string }[];
  value: number;
  onConfirm: (value: number) => void;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(
    Math.max(
      options.findIndex((o) => o.value === value),
      0,
    ),
  );

  return (
    <PickerSheetFrame title={title} onClose={onClose}>
      <WheelRow>
        <WheelColumn
          labels={options.map((o) => o.label)}
          index={selectedIndex}
          onChange={setSelectedIndex}
          testId={testId}
        />
      </WheelRow>
      <button
        type="button"
        onClick={() => onConfirm(options[selectedIndex].value)}
        className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
      >
        확인
      </button>
    </PickerSheetFrame>
  );
}

const AMPM_LABELS = ["오전", "오후"];
const DAY_LABELS = ["당일", "다음날"];
const HOUR12_LABELS = Array.from({ length: 12 }, (_, i) => `${i + 1}시`);

/**
 * 만나는/헤어지는 시간을 "오전·오후 + 1~12시"로 고르는 선택창.
 * 헤어지는 시간에는 새벽까지 노는 코스를 위해 "당일/다음날" 칸이 더 있다.
 * 값은 0~35(시)이며 24 이상은 다음날이다. 오전 12시=0, 오후 12시=12.
 */
function TimePickerSheet({
  title,
  value,
  withDay,
  minExclusive,
  onConfirm,
  onClose,
}: {
  title: string;
  value: number | null;
  withDay: boolean;
  /** 이 시각보다 늦은 시간만 고를 수 있다(헤어지는 시간 = 만나는 시간). 없으면 null. */
  minExclusive: number | null;
  onConfirm: (hour: number | null) => void;
  onClose: () => void;
}) {
  // 값이 없을 때 바퀴가 처음 놓일 자리: 만나는 시간은 오전 10시, 헤어지는 시간은 만나는 시간 3시간 뒤(없으면 오후 9시).
  const start =
    value ?? (withDay ? Math.min((minExclusive ?? 18) + 3, MAX_END_HOUR) : 10);
  const [day, setDay] = useState(start >= 24 ? 1 : 0);
  const [ampm, setAmpm] = useState(start % 24 >= 12 ? 1 : 0);
  const [hour12Index, setHour12Index] = useState((start % 12 || 12) - 1);

  const hour = day * 24 + ampm * 12 + ((hour12Index + 1) % 12);
  const tooEarly = minExclusive !== null && hour <= minExclusive;
  const tooLate = hour > MAX_END_HOUR;
  const error = tooEarly
    ? `만나는 시간(${hourLabel(minExclusive)})보다 늦어야 해요.`
    : tooLate
      ? `다음날은 ${hourLabel(MAX_END_HOUR)}까지만 고를 수 있어요.`
      : "";

  return (
    <PickerSheetFrame title={title} onClose={onClose}>
      {withDay && (
        <div className="flex gap-2" role="group" aria-label="당일 또는 다음날">
          {DAY_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => setDay(i)}
              aria-pressed={day === i}
              data-testid={`time-day-${i}`}
              className={`h-10 flex-1 rounded-lg border text-sm font-medium ${
                day === i
                  ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                  : "border-zinc-300 text-black dark:border-zinc-700 dark:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <WheelRow>
        <WheelColumn
          labels={AMPM_LABELS}
          index={ampm}
          onChange={setAmpm}
          testId="time-ampm"
        />
        <WheelColumn
          labels={HOUR12_LABELS}
          index={hour12Index}
          onChange={setHour12Index}
          testId="time-hour"
        />
      </WheelRow>
      <p
        className="min-h-5 text-center text-sm text-zinc-500 dark:text-zinc-400"
        role="status"
      >
        {error || `${hourLabel(hour)}`}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onConfirm(null)}
          className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-medium text-black dark:border-zinc-700 dark:text-white"
        >
          상관없음
        </button>
        <button
          type="button"
          disabled={Boolean(error)}
          onClick={() => onConfirm(hour)}
          className="h-12 flex-[2] rounded-xl bg-black text-base font-semibold text-white disabled:opacity-30 dark:bg-white dark:text-black"
        >
          확인
        </button>
      </div>
    </PickerSheetFrame>
  );
}

function StageRow({
  stage,
  fixed = false,
  onRemove,
  onRequestChangeDesignated,
}: {
  stage: Stage;
  /** 코스 시작지처럼 순서를 옮기거나 지울 수 없는 단계. */
  fixed?: boolean;
  onRemove: (id: string) => void;
  onRequestChangeDesignated: (stageId: string) => void;
}) {
  const dragControls = useDragControls();

  const rowClass =
    "flex flex-col gap-2 rounded-xl border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-black";

  const body = (
    <>
      <div className="flex items-center gap-2">
        {fixed ? (
          <span className="w-2 shrink-0" aria-hidden />
        ) : (
          <button
            type="button"
            aria-label="눌러서 순서 변경"
            onPointerDown={(e) => dragControls.start(e)}
            style={{ touchAction: "none" }}
            className="flex h-11 w-9 shrink-0 cursor-grab items-center justify-center text-xl text-zinc-400 active:cursor-grabbing dark:text-zinc-500"
          >
            ⠿
          </button>
        )}

        <div className="flex flex-1 items-center gap-2">
          {fixed && (
            <span className="w-fit shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              코스 시작지
            </span>
          )}
          <span className="flex flex-col text-base font-medium text-black dark:text-white">
            {stage.kind === "recommend"
              ? `${stage.category}${stage.subCategory ? ` · ${stage.subCategory}` : ""}`
              : isUnsetStage(stage)
                ? "상관없음"
                : stage.place.name}
            {stage.kind === "recommend" && stage.note && (
              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                {stage.note}
              </span>
            )}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onRequestChangeDesignated(stage.id)}
          className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
        >
          변경
        </button>

        {!fixed && (
          <button
            type="button"
            aria-label="단계 삭제"
            onClick={() => onRemove(stage.id)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg text-red-500 dark:border-zinc-700"
          >
            ✕
          </button>
        )}
      </div>
    </>
  );

  if (fixed) {
    return <div className={rowClass}>{body}</div>;
  }

  return (
    <Reorder.Item
      value={stage}
      dragListener={false}
      dragControls={dragControls}
      className={rowClass}
    >
      {body}
    </Reorder.Item>
  );
}

/** AI가 적은 장소 유형을 해석한 결과(카테고리·세부 카테고리·지도 검색어). */
type TypedStage = {
  category: PlaceCategory;
  subCategory?: string;
  keywords?: string[];
};

function AddStageSheet({
  canAddMore,
  onClose,
  onAddRecommend,
  onResolveTyped,
  onStartDesignated,
  onAddUnsetDesignated,
  title = "단계 추가",
}: {
  canAddMore: boolean;
  onClose: () => void;
  onAddRecommend: (
    category: PlaceCategory,
    subCategory: string | undefined,
    note?: string,
    keywords?: string[],
  ) => void;
  /** 적은 장소 유형을 AI가 카테고리로 바꿔 준다(못 알아내면 null). */
  onResolveTyped: (typeNote: string) => Promise<TypedStage | null>;
  onStartDesignated: () => void;
  onAddUnsetDesignated: () => void;
  title?: string;
}) {
  const [typeNote, setTypeNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [typeError, setTypeError] = useState(false);
  const note = typeNote.trim();

  async function addTyped() {
    if (!note || resolving) return;
    setResolving(true);
    setTypeError(false);
    const found = await onResolveTyped(note);
    setResolving(false);
    if (found) {
      onAddRecommend(found.category, found.subCategory, note, found.keywords);
    } else setTypeError(true);
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex max-h-[70vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>

        {!canAddMore && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            최대 8단계까지 추가할 수 있어요.
          </p>
        )}

        {canAddMore && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onStartDesignated}
                className="flex h-14 w-full items-center justify-center rounded-xl border border-zinc-300 text-base font-medium text-black dark:border-zinc-700 dark:text-white"
              >
                장소 직접 지정
              </button>
              <button
                type="button"
                onClick={onAddUnsetDesignated}
                className="flex h-14 w-full items-center justify-center rounded-xl border border-zinc-300 text-base font-medium text-black dark:border-zinc-700 dark:text-white"
              >
                상관없음
              </button>
            </div>
            <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
              <label
                htmlFor="stage-type-note"
                className="text-sm font-medium text-zinc-600 dark:text-zinc-400"
              >
                가고 싶은 장소 유형을 적어 보세요
              </label>
              <div className="flex gap-2">
                <input
                  id="stage-type-note"
                  type="text"
                  value={typeNote}
                  maxLength={MAX_STAGE_TYPE_NOTE_LENGTH}
                  onChange={(e) => {
                    setTypeNote(e.target.value);
                    setTypeError(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addTyped();
                  }}
                  placeholder="예: 북카페, 음식점, 야경 술집"
                  className="h-12 min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => void addTyped()}
                  disabled={!note || resolving}
                  className="h-12 shrink-0 rounded-xl bg-black px-4 text-base font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                >
                  {resolving ? "찾는 중…" : "AI로 추가"}
                </button>
              </div>
              {typeError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  AI가 장소 유형을 알아내지 못했어요. 다르게 적거나 위
                  카테고리를 골라 주세요.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 코스 시작 지역 선택 창. 시·도(큰 단위) 하나를 고르고, 원하면 그 안의 동(작은 단위)도 하나 고른다. "적용"을 눌러야 바뀐다. */
function RegionSheet({
  selected,
  onClose,
  onApply,
}: {
  selected: RegionSelection;
  onClose: () => void;
  onApply: (selection: RegionSelection) => void;
}) {
  const [areaId, setAreaId] = useState(selected.areaId);
  const [dongId, setDongId] = useState<string | null>(selected.dongId);
  // query는 입력 중인 글, submitted는 검색을 누른 글. 결과는 검색을 눌렀을 때만 나온다.
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const q = submitted.trim();
  // 동네는 검색한 것만 보여준다(처음부터 목록을 펼쳐 두지 않는다).
  const dongs = q
    ? DONGS.filter((d) => d.name.includes(q) || d.area.includes(q))
    : [];
  // 목록에 없는 전국의 구·동은 주소 검색(서버)으로 찾는다. 어떤 검색어의 결과인지 함께 들고 있는다.
  const [remote, setRemote] = useState<{
    q: string;
    items: { areaId: string; name: string; lat: number; lng: number }[];
  } | null>(null);
  useEffect(() => {
    if (q.length < 2) return;
    const controller = new AbortController();
    fetch(`/api/regions/search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((d: { results?: NonNullable<typeof remote>["items"] }) =>
        setRemote({ q, items: d.results ?? [] }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setRemote({ q, items: [] });
      });
    return () => controller.abort();
  }, [q]);
  const searching = q.length >= 2 && remote?.q !== q;
  const results: { key: string; label: string; selection: RegionSelection }[] =
    q
      ? [
          ...dongs.map((d) => ({
            key: d.id,
            label: `${d.area} · ${d.name}`,
            selection: { areaId: d.areaId, dongId: d.id },
          })),
          ...(remote?.q === q ? remote.items : []).map((r) => ({
            key: `${r.areaId}|${r.name}`,
            label: `${AREAS.find((a) => a.id === r.areaId)?.name ?? ""} · ${r.name}`,
            selection: {
              areaId: r.areaId,
              dongId: null,
              custom: { name: r.name, lat: r.lat, lng: r.lng },
            },
          })),
        ]
      : [];
  const pickedLabel = regionLabel(selectionRegions({ areaId, dongId })[0]);

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/50">
      <div
        role="dialog"
        aria-label="코스 시작 지역 선택"
        className="flex h-[80vh] w-full max-w-md flex-col gap-3 rounded-t-2xl bg-white p-4 dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            코스 시작 지역
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-xl text-zinc-500"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          코스를 시작할 지역이에요. 첫 장소는 이 주변에서 찾고, 그다음부터는 앞
          장소 주변에서 이어 찾아서 코스가 이 지역 밖으로 이어질 수 있어요.
        </p>
        <div className="flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // 입력을 모두 지우면 검색 결과도 닫고 시·도 버튼으로 돌아간다.
              if (!e.target.value.trim()) setSubmitted("");
            }}
            onKeyDown={(e) => {
              // 엔터도 검색 버튼과 같다. 결과는 검색을 눌렀을 때만 나온다.
              if (e.key === "Enter") setSubmitted(query);
            }}
            placeholder="동네 이름 검색 (전국, 예: 해운대)"
            aria-label="동네 이름 검색"
            className="h-11 min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
          />
          <button
            type="button"
            onClick={() => setSubmitted(query)}
            disabled={!query.trim()}
            className="h-11 shrink-0 rounded-xl bg-black px-4 text-base font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            검색
          </button>
        </div>
        {!q && (
          <div className="flex flex-wrap gap-1.5" aria-label="시·도">
            {AREAS.map((a) => {
              const on = a.id === areaId;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setAreaId(a.id);
                    setDongId(null);
                    setQuery("");
                  }}
                  aria-pressed={on}
                  className={`h-10 rounded-full border px-4 text-sm font-medium ${
                    on
                      ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                  }`}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            {q
              ? "검색 결과 (누르면 바로 적용돼요)"
              : "동네는 위 검색창에 이름을 치고 검색을 눌러 고를 수 있어요 (안 골라도 돼요)"}
          </span>
          {dongId && (
            <button
              type="button"
              onClick={() => setDongId(null)}
              className="h-8 rounded-lg px-2 text-xs font-medium text-zinc-500 underline"
            >
              선택 해제
            </button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto">
          {q && searching && results.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">찾는 중…</p>
          )}
          {q && !searching && results.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              맞는 동네가 없어요. 구·동 이름을 더 정확히 써 보세요.
            </p>
          )}
          {q
            ? results.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  // 검색 결과를 누르면 시·도까지 함께 정해서 바로 코스 시작 지역으로 적용한다.
                  onClick={() => onApply(r.selection)}
                  className="h-10 rounded-full border border-zinc-300 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                >
                  {r.label}
                </button>
              ))
            : null}
        </div>
        <button
          type="button"
          onClick={() => onApply({ areaId, dongId })}
          className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
        >
          {pickedLabel}에서 시작
        </button>
      </div>
    </div>
  );
}

function DesignatedPlaceSheet({
  initial,
  recentPlaces,
  currentLocation,
  locationStatus,
  onClose,
  onSubmit,
}: {
  initial: DesignatedPlace | null;
  recentPlaces: DesignatedPlace[];
  currentLocation: { lat: number; lng: number } | null;
  locationStatus: LocationStatus;
  onClose: () => void;
  onSubmit: (place: DesignatedPlace) => void;
}) {
  const { regions, center } = useRegionContext();
  const [query, setQuery] = useState("");
  // 지도 창: 현재 위치에서 시작(current) / 빈 지도에서 시작(free) / 닫힘(null).
  const [mapPick, setMapPick] = useState<"current" | "free" | null>(null);
  // 지도 창에서 "완료"로 골라 둔 위치. 결과 목록에 띄워 두고, 눌러야 확정된다.
  const [pendingPlace, setPendingPlace] = useState<DesignatedPlace | null>(
    null,
  );
  // 네이버 Geocoding(주소 검색) 결과. 어떤 검색어의 결과인지 함께 들고 있다가, 지금 검색어와 같을 때만 보여준다.
  const [geo, setGeo] = useState<{
    q: string;
    items: PlaceSearchResult[];
  } | null>(null);
  // TMAP 장소 이름 검색 결과(같은 방식으로 검색어와 함께 보관).
  const [tmap, setTmap] = useState<{
    q: string;
    items: PlaceSearchResult[];
  } | null>(null);
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (trimmedQuery.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/maps/geocode?q=${encodeURIComponent(trimmedQuery)}&lat=${center.lat}&lng=${center.lng}`,
        {
          signal: ctrl.signal,
        },
      )
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results?: PlaceSearchResult[] }) =>
          setGeo({ q: trimmedQuery, items: d.results ?? [] }),
        )
        .catch(() => {});
      fetch(
        `/api/tmap/search?q=${encodeURIComponent(trimmedQuery)}&lat=${center.lat}&lng=${center.lng}`,
        {
          signal: ctrl.signal,
        },
      )
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results?: PlaceSearchResult[] }) =>
          setTmap({ q: trimmedQuery, items: d.results ?? [] }),
        )
        .catch(() => {});
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [trimmedQuery, center.lat, center.lng]);
  // 실제 검색 결과(장소 이름은 TMAP, 주소는 네이버)를 먼저 보여준다.
  // 아직 안 왔거나 둘 다 비어 있으면 예시 데이터로 대신한다(키가 없을 때도 동작하게).
  const results = useMemo(() => {
    const real = [
      ...(tmap && tmap.q === trimmedQuery ? tmap.items : []),
      ...(geo && geo.q === trimmedQuery ? geo.items : []),
    ];
    if (real.length > 0) return real;
    // 예시 데이터(종로)는 종로를 골랐을 때만 보여준다.
    return includesSampleRegion(regions) ? searchPlaces(query) : [];
  }, [query, geo, tmap, trimmedQuery, regions]);

  const hasQuery = query.trim().length > 0;

  function pick(place: DesignatedPlace) {
    onSubmit({
      id: place.id,
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
    });
  }

  const currentPlace: DesignatedPlace | null = currentLocation && {
    id: CURRENT_LOCATION_PLACE_ID,
    name: "현재 위치",
    address: "내 현재 위치",
    lat: currentLocation.lat,
    lng: currentLocation.lng,
  };
  const locationHint =
    locationStatus === "loading" || locationStatus === "idle"
      ? "현재 위치를 확인하는 중이에요."
      : "위치 권한이 꺼져 있거나 위치를 알 수 없어요. 브라우저 설정에서 위치를 허용해 주세요.";

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50">
      <div className="flex h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {initial ? "지정 장소 변경" : "장소 직접 지정"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="장소 이름 또는 주소 (예: 경복궁)"
            aria-label="장소 이름"
            className="h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!currentPlace}
              onClick={() => currentPlace && setMapPick("current")}
              className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border border-zinc-300 text-sm font-medium text-black disabled:opacity-50 dark:border-zinc-700 dark:text-white"
            >
              <span aria-hidden>📍</span>현재 위치로 지정
            </button>
            <button
              type="button"
              onClick={() => setMapPick("free")}
              className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border border-zinc-300 text-sm font-medium text-black dark:border-zinc-700 dark:text-white"
            >
              <span aria-hidden>🗺️</span>지도에서 지정
            </button>
          </div>
          {!currentPlace && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {locationHint}
            </p>
          )}
          {initial && !hasQuery && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              지금 지정된 장소: {initial.name}
            </p>
          )}
        </div>

        {pendingPlace && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              선택한 위치
            </span>
            <button
              type="button"
              onClick={() => pick(pendingPlace)}
              aria-label={`${pendingPlace.name} 지정하기`}
              className="flex w-full items-center rounded-xl border-2 border-black px-3 py-2.5 text-left dark:border-white"
            >
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="text-lg font-bold text-black dark:text-white">
                  {pendingPlace.name}
                </span>
                {pendingPlace.address !== pendingPlace.name && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {pendingPlace.address}
                  </span>
                )}
              </span>
            </button>
          </div>
        )}

        {hasQuery ? (
          results.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              검색 결과가 없어요. 다른 이름으로 검색해보세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {results.map((p) => {
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      className="flex w-full flex-col items-start gap-0.5 rounded-xl border border-zinc-300 px-3 py-2.5 text-left dark:border-zinc-700"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-base font-medium text-black dark:text-white">
                          {p.name}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                          {p.category}
                        </span>
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {p.address}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          recentPlaces.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                최근 지정 장소
              </span>
              <ul className="flex flex-col gap-2">
                {recentPlaces.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      className="flex w-full flex-col items-start rounded-xl border border-zinc-300 px-3 py-2.5 text-left dark:border-zinc-700"
                    >
                      <span className="text-base font-medium text-black dark:text-white">
                        {p.name}
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {p.address}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}

        <p className="mt-auto text-xs text-zinc-400 dark:text-zinc-500">
          {regionLabel(regions[0])} 주변을 먼저 보여드려요. 다른 지역 장소도
          이름을 정확히 치면 찾을 수 있어요.
        </p>
      </div>

      {mapPick && (
        <MapPickSheet
          title={mapPick === "current" ? "현재 위치 확인" : "지도에서 지정"}
          initial={mapPick === "current" ? currentLocation : null}
          onClose={() => setMapPick(null)}
          onConfirm={(point, info) => {
            // 현재 위치 그대로면 "현재 위치", 지도에서 옮기거나 새로 골랐으면 "지도에서 고른 위치".
            const unmoved =
              currentPlace !== null &&
              point.lat === currentPlace.lat &&
              point.lng === currentPlace.lng;
            setMapPick(null);
            setPendingPlace(
              unmoved
                ? currentPlace
                : {
                    id: MAP_PICK_PLACE_ID,
                    // 이름 있는 장소면 그 이름, 아니면 주소를 이름 자리에 크게 보여준다.
                    name: info.name ?? info.address ?? "지도에서 고른 위치",
                    address: info.address ?? "지도에서 직접 고른 위치",
                    lat: point.lat,
                    lng: point.lng,
                  },
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * 지도를 눌러 위치를 고르는 창. 네이버 지도를 연결하기 전이라 종로 일대를 그린 임시 지도다.
 * 지도를 누르면 핀이 꽂히고, "완료"를 누르면 그 좌표가 지정 장소 창의 "선택한 위치"로 올라간다.
 */
function pickMapBounds(center: { lat: number; lng: number }) {
  return {
    minLat: center.lat - 0.012,
    maxLat: center.lat + 0.012,
    minLng: center.lng - 0.015,
    maxLng: center.lng + 0.015,
  };
}

function MapPickSheet({
  title,
  initial,
  onClose,
  onConfirm,
}: {
  title: string;
  /** 처음부터 꽂아 둘 위치(현재 위치). 없으면 빈 지도에서 시작한다. */
  initial: { lat: number; lng: number } | null;
  onClose: () => void;
  onConfirm: (
    point: { lat: number; lng: number },
    info: { address: string | null; name: string | null },
  ) => void;
}) {
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(
    initial,
  );
  const maps = useNaverMaps();
  // 지도를 끄는 중이면 핀을 살짝 들어 올린다(택시 앱처럼).
  const [moving, setMoving] = useState(false);
  // 핀이 가리키는 곳의 주소(어느 좌표의 주소인지 함께 들고 있다가 지금 위치와 같을 때만 보여준다).
  const [addr, setAddr] = useState<{
    key: string;
    address: string | null;
    name: string | null;
  } | null>(null);
  const pickedKey = picked ? `${picked.lat},${picked.lng}` : null;
  useEffect(() => {
    if (maps !== "ready" || !picked || !pickedKey) return;
    const ctrl = new AbortController();
    fetch(`/api/maps/reverse?lat=${picked.lat}&lng=${picked.lng}`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : { address: null }))
      .then((d: { address: string | null; name?: string | null }) =>
        setAddr({ key: pickedKey, address: d.address, name: d.name ?? null }),
      )
      .catch(() => {});
    return () => ctrl.abort();
  }, [maps, picked, pickedKey]);
  const addrInfo =
    addr && addr.key === pickedKey
      ? { address: addr.address, name: addr.name }
      : { address: null, name: null };
  const drawable = MAP_VIEW_SIZE - MAP_MARGIN * 2;
  const { center: regionCenter } = useRegionContext();
  const b = pickMapBounds(regionCenter);

  function onTap(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * MAP_VIEW_SIZE;
    const y = ((e.clientY - rect.top) / rect.height) * MAP_VIEW_SIZE;
    const fx = Math.min(1, Math.max(0, (x - MAP_MARGIN) / drawable));
    const fy = Math.min(1, Math.max(0, (y - MAP_MARGIN) / drawable));
    setPicked({
      lat: b.maxLat - fy * (b.maxLat - b.minLat),
      lng: b.minLng + fx * (b.maxLng - b.minLng),
    });
  }

  const pinRaw = picked ? projectToMap({ ...picked, name: "" }, b) : null;
  // 임시 지도(고른 지역 일대) 밖이면 핀을 그리지 않고 안내만 한다.
  const pin =
    pinRaw &&
    pinRaw.x >= 0 &&
    pinRaw.x <= MAP_VIEW_SIZE &&
    pinRaw.y >= 0 &&
    pinRaw.y <= MAP_VIEW_SIZE
      ? pinRaw
      : null;
  const pinOffMap = picked !== null && pin === null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-t-2xl bg-white p-4 dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {maps === "ready"
            ? initial
              ? "핀이 현재 위치예요. 지도를 움직여 핀을 원하는 곳에 맞춰 주세요."
              : "지도를 움직여 핀을 원하는 곳에 맞춰 주세요."
            : initial
              ? "빨간 핀이 현재 위치예요. 지도를 눌러 위치를 옮길 수 있어요."
              : "지도를 눌러 위치를 골라 주세요."}
        </p>
        {maps !== "ready" && pinOffMap && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            현재 위치가 임시 지도 범위 밖이라 핀이 보이지 않아요. 그대로
            지정하거나 지도를 눌러 옮길 수 있어요.
          </p>
        )}
        {maps === "ready" ? (
          <div className="relative h-[48vh] max-h-[440px] min-h-[240px] w-full overflow-hidden rounded-xl">
            <NaverMapCanvas
              ariaLabel="네이버 지도(움직여서 위치 고르기)"
              className="h-full w-full"
              initialCenter={initial ?? regionCenter}
              initialZoom={17}
              onMovingChange={setMoving}
              onCenterChange={(c) => {
                // 현재 위치 그대로면 값을 그대로 쓴다(미세한 계산 오차로 "옮겼다"고 오해하지 않게).
                if (
                  initial &&
                  Math.abs(c.lat - initial.lat) < 1e-5 &&
                  Math.abs(c.lng - initial.lng) < 1e-5 &&
                  (!picked ||
                    (Math.abs(picked.lat - initial.lat) < 1e-5 &&
                      Math.abs(picked.lng - initial.lng) < 1e-5))
                ) {
                  setPicked(initial);
                  return;
                }
                setPicked(c);
              }}
            />
            {/* 지도 한가운데 고정된 핀: 지도를 움직이면 핀이 가리키는 곳이 바뀐다. */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 z-10"
            >
              <div className="absolute -left-1.5 -top-1 h-2 w-3 rounded-full bg-black/30 blur-[1px]" />
              <svg
                width="32"
                height="44"
                viewBox="0 0 32 44"
                className={`absolute -left-4 -top-11 transition-transform duration-150 ${moving ? "-translate-y-2" : ""}`}
              >
                <path
                  d="M16 1C8 1 2 7 2 15c0 10 14 28 14 28s14-18 14-28C30 7 24 1 16 1z"
                  fill="#ef4444"
                  stroke="#fff"
                  strokeWidth="2"
                />
                <circle cx="16" cy="15" r="5" fill="#fff" />
              </svg>
            </div>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${MAP_VIEW_SIZE} ${MAP_VIEW_SIZE}`}
            onClick={onTap}
            aria-label="종로 일대 임시 지도"
            className="aspect-square w-full cursor-crosshair rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i} stroke="currentColor" strokeOpacity={0.3}>
                <line
                  x1={MAP_MARGIN + (drawable / 4) * i}
                  y1={MAP_MARGIN}
                  x2={MAP_MARGIN + (drawable / 4) * i}
                  y2={MAP_VIEW_SIZE - MAP_MARGIN}
                />
                <line
                  x1={MAP_MARGIN}
                  y1={MAP_MARGIN + (drawable / 4) * i}
                  x2={MAP_VIEW_SIZE - MAP_MARGIN}
                  y2={MAP_MARGIN + (drawable / 4) * i}
                />
              </g>
            ))}
            {MAP_LANDMARKS.map((lm) => {
              const pt = projectToMap(lm, b);
              if (
                pt.x < 0 ||
                pt.x > MAP_VIEW_SIZE ||
                pt.y < 0 ||
                pt.y > MAP_VIEW_SIZE
              )
                return null;
              return (
                <g key={lm.id} pointerEvents="none">
                  <circle cx={pt.x} cy={pt.y} r={4} fill="currentColor" />
                  <text
                    x={pt.x + 7}
                    y={pt.y + 4}
                    fontSize={12}
                    fill="currentColor"
                  >
                    {lm.name}
                  </text>
                </g>
              );
            })}
            {pin && (
              <g pointerEvents="none">
                <circle cx={pin.x} cy={pin.y} r={9} fill="#ef4444" />
                <circle cx={pin.x} cy={pin.y} r={3.5} fill="white" />
              </g>
            )}
          </svg>
        )}
        {maps === "ready" && (
          <p className="min-h-5 text-sm font-medium text-black dark:text-white">
            {moving || !picked ? (
              <span className="text-base font-semibold">위치를 맞추는 중…</span>
            ) : addrInfo.name ? (
              <>
                <span className="block text-lg font-bold">{addrInfo.name}</span>
                <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400">
                  {addrInfo.address}
                </span>
              </>
            ) : (
              <span className="text-lg font-bold">
                {addrInfo.address ?? "주소를 찾을 수 없는 곳이에요"}
              </span>
            )}
          </p>
        )}
        <button
          type="button"
          disabled={!picked || moving}
          onClick={() => picked && onConfirm(picked, addrInfo)}
          className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          완료
        </button>
        {maps !== "ready" && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            지금은 고른 지역 일대를 그린 임시 지도예요. 네이버 지도를 불러오면
            실제 지도로 바뀌어요.
          </p>
        )}
      </div>
    </div>
  );
}

function useResizableSplit(
  defaultRatio: number,
  bodyRef: React.RefObject<HTMLDivElement | null>,
) {
  const [ratio, setRatio] = useState(defaultRatio);
  const dragRef = useRef<{
    startY: number;
    startRatio: number;
    height: number;
  } | null>(null);

  function onHandlePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startRatio: ratio,
      height: bodyRef.current?.clientHeight ?? 1,
    };
  }

  function onHandlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaRatio = -(e.clientY - drag.startY) / drag.height;
    setRatio(
      Math.min(
        MAX_LIST_RATIO,
        Math.max(MIN_LIST_RATIO, drag.startRatio + deltaRatio),
      ),
    );
  }

  function onHandlePointerUp() {
    dragRef.current = null;
  }

  return { ratio, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp };
}

function DragHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      aria-orientation="horizontal"
      aria-label="지도와 목록 크기 조절"
      style={{ touchAction: "none" }}
      className="flex h-7 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
    >
      <div className="h-1.5 w-12 rounded-full bg-zinc-300 dark:bg-zinc-700" />
    </div>
  );
}

/** 결과 화면에서 끌어서 순서를 바꿀 수 있는 한 칸. 손잡이(⠿)를 잡고 끈다. */
function ReorderableResultItem({
  id,
  children,
}: {
  id: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const dragControls = useDragControls();
  const handle = (
    <button
      type="button"
      aria-label="눌러서 순서 변경"
      onPointerDown={(e) => dragControls.start(e)}
      style={{ touchAction: "none" }}
      className="flex h-9 w-7 shrink-0 cursor-grab items-center justify-center text-xl text-zinc-400 active:cursor-grabbing dark:text-zinc-500"
    >
      ⠿
    </button>
  );
  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={dragControls}
      className="flex flex-col gap-3 bg-white dark:bg-black"
    >
      {children(handle)}
    </Reorder.Item>
  );
}

/** 블로그 검색용 동네 이름: 주소("성동구 성수동1가")의 마지막 단어. */
function blurbAreaOf(region: string): string {
  return region.trim().split(/\s+/).pop() ?? "";
}

function ResultView({
  result,
  avatarPoint,
  onBack,
  onReplace,
  onReorderStages,
  onRequestChangeTheme,
  onRemoveStage,
  onAddStage,
  onDecideRoute,
}: {
  result: CourseResult;
  avatarPoint: { lat: number; lng: number };
  onBack: () => void;
  onReplace: (stageId: string, placeId: string) => void;
  /** 모든 단계 id를 새 순서대로 넘긴다(맨 위가 코스 시작지가 된다). */
  onReorderStages: (orderedIds: string[]) => void;
  onRequestChangeTheme: (stageId: string) => void;
  onRemoveStage: (stageId: string) => void;
  onAddStage: () => void;
  onDecideRoute: () => void;
}) {
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  // 코스를 바꾸면(장소 교체 등) 저장 상태를 처음으로 되돌리기 위해 어떤 결과를 저장했는지 함께 기억한다.
  const [saveStatus, setSaveStatus] = useState<{
    result: CourseResult;
    ok: boolean;
  } | null>(null);
  const saveState =
    saveStatus?.result === result
      ? saveStatus.ok
        ? "saved"
        : "failed"
      : "idle";
  const { loadingPlaces } = useRegionContext();
  // 실제 장소(TMAP)의 한 줄 소개: 코스는 먼저 보여주고 소개는 도착하는 대로 기존 설명 줄에 채운다.
  useSyncExternalStore(subscribeBlurbs, blurbVersion, blurbVersion);
  const livePicks = result.stages
    .map((s) => s.selected)
    .filter((p): p is Place => !!p && "source" in p && p.source === "tmap");
  const livePicksKey = livePicks.map((p) => p.id).join(",");
  useEffect(() => {
    const byArea = new Map<string, { n: string; c: string }[]>();
    for (const p of livePicks) {
      const area = blurbAreaOf(p.region);
      byArea.set(area, [
        ...(byArea.get(area) ?? []),
        {
          n: p.name,
          c: p.subCategory ? `${p.category} › ${p.subCategory}` : p.category,
        },
      ]);
    }
    byArea.forEach((list, area) => void requestBlurbs(area, list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePicksKey]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const split = useResizableSplit(DEFAULT_LIST_RATIO, bodyRef);
  const openStageIndex = result.stages.findIndex(
    (s) => s.stage.id === openStageId,
  );
  const openStageResult =
    openStageIndex === -1 ? null : result.stages[openStageIndex];
  const nextSelected =
    openStageIndex === -1
      ? null
      : (result.stages[openStageIndex + 1]?.selected ?? null);
  const decidedStages =
    openStageIndex === -1
      ? []
      : result.stages
          .slice(0, openStageIndex)
          .filter((s) => s.selected !== null);

  const failedIndex = result.stages.findIndex(
    (s): s is RecommendStageResult =>
      s.kind === "recommend" && s.selected === null,
  );
  const failedStage =
    failedIndex === -1
      ? null
      : (result.stages[failedIndex] as RecommendStageResult);
  const blockingDesignated =
    failedStage?.blockedByDesignated &&
    result.stages[failedIndex + 1]?.kind === "designated"
      ? result.stages[failedIndex + 1]
      : null;

  const movableIds = result.stages.map((r) => r.stage.id);

  function renderStage(
    stageResult: CourseResult["stages"][number],
    index: number,
    handle: React.ReactNode,
  ) {
    return (
      <>
        {index > 0 && stageResult.travelMinutesFromPrevious !== null && (
          <p
            className={`text-center text-sm ${
              stageResult.kind === "designated" && stageResult.travelExceedsMax
                ? "font-medium text-amber-600 dark:text-amber-400"
                : "text-zinc-400 dark:text-zinc-500"
            }`}
          >
            도보 약 {Math.round(stageResult.travelMinutesFromPrevious)}분
            {stageResult.kind === "designated" && stageResult.travelExceedsMax
              ? " · 설정보다 길어요"
              : ""}
          </p>
        )}

        {stageResult.kind === "recommend" && stageResult.selected && (
          <div className="flex items-center gap-1 rounded-xl border border-zinc-300 py-4 pl-1.5 pr-4 dark:border-zinc-700">
            {handle}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-lg font-semibold text-black dark:text-white">
                    {stageResult.selected.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRequestChangeTheme(stageResult.stage.id)}
                    aria-label="테마 바꾸기"
                    className="flex w-fit items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {stageResult.selected.category}
                    {stageResult.selected.subCategory
                      ? ` · ${stageResult.selected.subCategory}`
                      : ""}
                    <span aria-hidden className="text-[10px]">
                      ▾
                    </span>
                  </button>
                </div>
              </div>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {stageResult.selected.source === "tmap"
                  ? getBlurb(
                      stageResult.selected.name,
                      blurbAreaOf(stageResult.selected.region),
                    ) || stageResult.selected.description
                  : `★ ${stageResult.selected.rating.toFixed(1)} · 리뷰 ${stageResult.selected.reviewCount.toLocaleString()}개`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setOpenStageId(stageResult.stage.id)}
                className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
              >
                교체
              </button>
              <button
                type="button"
                onClick={() => onRemoveStage(stageResult.stage.id)}
                aria-label="이 단계 삭제"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {stageResult.kind === "designated" && (
          <div className="flex items-center gap-1 rounded-xl border border-zinc-300 py-4 pl-1.5 pr-4 dark:border-zinc-700">
            {handle}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-1 items-center">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-lg font-semibold text-black dark:text-white">
                    {stageResult.selected.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRequestChangeTheme(stageResult.stage.id)}
                    aria-label="지정 장소 바꾸기"
                    className="flex w-fit items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    지정
                    <span aria-hidden className="text-[10px]">
                      ▾
                    </span>
                  </button>
                </div>
              </div>
              <span className="text-sm text-zinc-500 dark:text-zinc-500">
                {stageResult.selected.address}
              </span>
              <a
                href={naverMapLinkFor(stageResult.selected)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-blue-600 dark:text-blue-400"
              >
                네이버맵에서 보기
              </a>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => onRemoveStage(stageResult.stage.id)}
                aria-label="이 단계 삭제"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col bg-white dark:bg-black">
      <div className="mx-auto flex w-full max-w-md shrink-0 items-center gap-3 p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="뒤로"
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg dark:border-zinc-700 dark:text-white"
        >
          ←
        </button>
        <h1 className="text-2xl font-bold text-black dark:text-white">
          추천 결과
        </h1>
      </div>

      {loadingPlaces && (
        <p
          role="status"
          className="mx-auto w-full max-w-md px-4 pb-2 text-sm text-zinc-500 dark:text-zinc-400"
        >
          선택한 지역에서 장소를 찾는 중이에요…
        </p>
      )}

      {!result.success ? (
        <div className="mx-auto w-full max-w-md px-4 pb-6">
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <p className="text-base text-zinc-600 dark:text-zinc-300">
              {loadingPlaces
                ? "장소를 불러오면 코스를 보여드릴게요."
                : `${failedIndex + 1}번째 단계에서 조건에 맞는 곳을 찾지 못했어요.`}
            </p>
            {blockingDesignated && blockingDesignated.kind === "designated" ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                &apos;{blockingDesignated.stage.place.name}&apos; 지정 장소
                근처라서 그래요. 구간별 최대 이동시간을 늘리거나 지정 장소를
                바꿔보세요.
              </p>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                구간별 최대 이동시간을 늘리거나 세부 카테고리를 해제해보세요.
              </p>
            )}
            {failedStage?.kind === "recommend" &&
              failedStage.closedExcludedCount > 0 && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  일정 날짜에 쉬는 {failedStage.closedExcludedCount}곳은
                  후보에서 제외됐어요. 날짜를 바꿔보는 것도 방법이에요.
                </p>
              )}
          </div>
        </div>
      ) : (
        <div
          ref={bodyRef}
          className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col"
        >
          <div
            style={{ flexGrow: 1 - split.ratio, flexBasis: 0 }}
            className="min-h-0 overflow-hidden"
          >
            <RouteMap stages={result.stages} avatarPoint={avatarPoint} />
          </div>

          <DragHandle
            onPointerDown={split.onHandlePointerDown}
            onPointerMove={split.onHandlePointerMove}
            onPointerUp={split.onHandlePointerUp}
          />

          <div
            style={{ flexGrow: split.ratio, flexBasis: 0 }}
            className="min-h-0 overflow-y-auto px-4 pb-4"
          >
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                총 이동시간 약 {Math.round(result.totalTravelMinutes)}분
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                칩(▾)을 누르면 바꿀 수 있어요
              </p>
            </div>

            <Reorder.Group
              axis="y"
              values={movableIds}
              onReorder={onReorderStages}
              className="flex flex-col gap-3"
            >
              {movableIds.map((id) => {
                const index = result.stages.findIndex((r) => r.stage.id === id);
                const stageResult = result.stages[index];
                return (
                  <ReorderableResultItem key={id} id={id}>
                    {(handle) => renderStage(stageResult, index, handle)}
                  </ReorderableResultItem>
                );
              })}
            </Reorder.Group>
            <button
              type="button"
              onClick={onAddStage}
              className="mt-3 flex h-12 w-full items-center justify-center rounded-xl border border-dashed border-zinc-300 text-base font-medium text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
            >
              + 단계 추가
            </button>
          </div>
        </div>
      )}

      {result.success && (
        <div className="mx-auto flex w-full max-w-md shrink-0 flex-col gap-2 p-4 pt-0">
          {saveState === "failed" && (
            <p
              role="alert"
              className="text-center text-sm text-red-600 dark:text-red-400"
            >
              저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const course = toSavedCourse(result);
                setSaveStatus({
                  result,
                  ok: course ? saveCourse(course) : false,
                });
              }}
              disabled={saveState === "saved"}
              className="h-14 flex-1 rounded-xl border border-zinc-300 text-lg font-semibold text-black disabled:opacity-60 dark:border-zinc-700 dark:text-white"
            >
              {saveState === "saved" ? "저장됨 ✓" : "동선 저장"}
            </button>
            <button
              type="button"
              onClick={onDecideRoute}
              className="h-14 flex-1 rounded-xl bg-black text-lg font-semibold text-white dark:bg-white dark:text-black"
            >
              이동 시작!
            </button>
          </div>
        </div>
      )}

      {openStageResult && openStageResult.kind === "recommend" && (
        <ReplaceSheet
          stageResult={openStageResult}
          decidedStages={decidedStages}
          nextSelected={nextSelected}
          onClose={() => setOpenStageId(null)}
          onSelect={(placeId) => {
            onReplace(openStageResult.stage.id, placeId);
            setOpenStageId(null);
          }}
        />
      )}
    </div>
  );
}

const MAP_VIEW_SIZE = 400;
const MAP_MARGIN = 40;
const MIN_LIST_RATIO = 0.2;
const MAX_LIST_RATIO = 0.75;
const DEFAULT_LIST_RATIO = 0.45;

type MapPoint = { lat: number; lng: number; name: string };

function computeMapBounds(points: MapPoint[]) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);
  if (minLat === maxLat) {
    minLat -= 0.001;
    maxLat += 0.001;
  }
  if (minLng === maxLng) {
    minLng -= 0.001;
    maxLng += 0.001;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function projectToMap(
  point: MapPoint,
  bounds: ReturnType<typeof computeMapBounds>,
) {
  const drawable = MAP_VIEW_SIZE - MAP_MARGIN * 2;
  const x =
    MAP_MARGIN +
    ((point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * drawable;
  const y =
    MAP_MARGIN +
    ((bounds.maxLat - point.lat) / (bounds.maxLat - bounds.minLat)) * drawable;
  return { x, y };
}

const ZOOM_MIN_SCALE = 1;
const ZOOM_MAX_SCALE = 4;

function clampZoomScale(scale: number) {
  return Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, scale));
}

/** SVG 지도를 손가락(핀치)이나 마우스 휠로 확대·축소하고, 확대 중엔 드래그로 이동한다. */
function useZoomPan() {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    mid: { x: number; y: number };
  } | null>(null);
  const panRef = useRef<{
    x: number;
    y: number;
    translate: { x: number; y: number };
  } | null>(null);

  const zoomAt = useCallback(
    (
      point: { x: number; y: number },
      s0: number,
      t0: { x: number; y: number },
      nextScaleRaw: number,
    ) => {
      const s1 = clampZoomScale(nextScaleRaw);
      setScale(s1);
      setTranslate({
        x: point.x - ((point.x - t0.x) * s1) / s0,
        y: point.y - ((point.y - t0.y) * s1) / s0,
      });
    },
    [],
  );

  // 휠로 확대/축소할 때 페이지가 같이 스크롤되지 않도록 e.preventDefault()가 필요한데,
  // React의 onWheel은 passive 리스너로 붙어서 그 안에서 preventDefault를 호출하면
  // "Unable to preventDefault inside passive event listener invocation" 콘솔 에러가 난다.
  // 그래서 ref로 DOM에 직접 passive:false 리스너를 붙인다.
  const scaleRef = useRef(scale);
  const translateRef = useRef(translate);
  useEffect(() => {
    scaleRef.current = scale;
    translateRef.current = translate;
  }, [scale, translate]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(
        point,
        scaleRef.current,
        translateRef.current,
        scaleRef.current * factor,
      );
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      };
      panRef.current = null;
    } else if (pointers.current.size === 1) {
      panRef.current = { x: e.clientX, y: e.clientY, translate };
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const pinch = pinchRef.current;
      zoomAt(
        pinch.mid,
        pinch.scale,
        translate,
        pinch.scale * (distance / pinch.distance),
      );
    } else if (pointers.current.size === 1 && panRef.current) {
      setTranslate({
        x: panRef.current.translate.x + (e.clientX - panRef.current.x),
        y: panRef.current.translate.y + (e.clientY - panRef.current.y),
      });
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    pinchRef.current = null;
    const remaining = [...pointers.current.entries()];
    panRef.current =
      remaining.length === 1
        ? { x: remaining[0][1].x, y: remaining[0][1].y, translate }
        : null;
  }

  function reset() {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }

  // svgRef는 다른 값들과 분리해서 반환한다: 하나의 객체에 ref와 렌더용 값을 같이 담으면
  // 렌더 중 zoomPan.scale처럼 접근할 때도 린트가 "ref를 렌더 중 접근"으로 오인한다.
  return [
    {
      scale,
      translate,
      isZoomed:
        scale > 1.001 || Math.abs(translate.x) + Math.abs(translate.y) > 1,
      handlers: { onPointerDown, onPointerMove, onPointerUp },
      reset,
    },
    svgRef,
  ] as const;
}

function ZoomResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="지도 확대 원래대로"
      className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white/90 text-sm text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300"
    >
      ⟲
    </button>
  );
}

function ReplaceSheet({
  stageResult,
  decidedStages,
  nextSelected,
  onClose,
  onSelect,
}: {
  stageResult: RecommendStageResult;
  decidedStages: StageResult[];
  nextSelected: Place | DesignatedPlace | null;
  onClose: () => void;
  onSelect: (placeId: string) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(
    stageResult.selected?.id ?? null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const split = useResizableSplit(DEFAULT_LIST_RATIO, bodyRef);

  const previewCandidate = stageResult.candidates.find(
    (c) => c.place.id === previewId,
  );

  // 실제 장소(TMAP) 후보는 블로그+AI 한 줄 소개를 위쪽 12곳까지 가져와 설명 줄에 채운다.
  useSyncExternalStore(subscribeBlurbs, blurbVersion, blurbVersion);
  const candidateKey = stageResult.candidates
    .slice(0, 12)
    .map((c) => c.place.id)
    .join(",");
  useEffect(() => {
    const live = stageResult.candidates
      .slice(0, 12)
      .map((c) => c.place)
      .filter((p) => p.source === "tmap");
    const byArea = new Map<string, { n: string; c: string }[]>();
    for (const p of live) {
      const area = blurbAreaOf(p.region);
      byArea.set(area, [
        ...(byArea.get(area) ?? []),
        {
          n: p.name,
          c: p.subCategory ? `${p.category} › ${p.subCategory}` : p.category,
        },
      ]);
    }
    byArea.forEach((list, area) => {
      for (let i = 0; i < list.length; i += 6) {
        void requestBlurbs(area, list.slice(i, i + 6));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-white dark:bg-black">
      <div className="flex shrink-0 items-center justify-between p-4">
        <h2 className="text-lg font-bold text-black dark:text-white">
          다른 장소로 교체
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
        >
          ✕
        </button>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        <div
          style={{ flexGrow: 1 - split.ratio, flexBasis: 0 }}
          className="min-h-0 overflow-hidden"
        >
          <StubMap
            decidedStages={decidedStages}
            candidates={stageResult.candidates}
            previewPlaceId={previewId}
            nextSelected={nextSelected}
            onTapCandidate={setPreviewId}
          />
        </div>

        <DragHandle
          onPointerDown={split.onHandlePointerDown}
          onPointerMove={split.onHandlePointerMove}
          onPointerUp={split.onHandlePointerUp}
        />

        <div
          style={{ flexGrow: split.ratio, flexBasis: 0 }}
          className="min-h-0 overflow-y-auto px-4 pb-4"
        >
          <ul className="flex flex-col gap-2">
            {stageResult.candidates.map((candidate) => {
              const isApplied = candidate.place.id === stageResult.selected?.id;
              const isPreviewed = candidate.place.id === previewId;
              const description =
                (candidate.place.source === "tmap"
                  ? getBlurb(
                      candidate.place.name,
                      blurbAreaOf(candidate.place.region),
                    )
                  : "") || candidate.place.description;

              return (
                <li key={candidate.place.id}>
                  <button
                    type="button"
                    onClick={() => setPreviewId(candidate.place.id)}
                    className={`flex w-full flex-col gap-1 rounded-xl border p-3 text-left ${
                      isPreviewed
                        ? "border-black dark:border-white"
                        : "border-zinc-300 dark:border-zinc-700"
                    } ${candidate.withinMaxTravel ? "" : "opacity-40"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-black dark:text-white">
                        {candidate.place.name}
                        {isApplied ? " (현재 적용됨)" : ""}
                      </span>
                      <span className="shrink-0 text-sm text-zinc-600 dark:text-zinc-400">
                        {candidate.place.source === "tmap"
                          ? candidate.place.region
                          : `★ ${candidate.place.rating.toFixed(1)}`}
                      </span>
                    </div>
                    {description && (
                      <span className="text-sm text-zinc-500 dark:text-zinc-400">
                        {description}
                      </span>
                    )}
                    {!candidate.withinMaxTravel && (
                      <span className="w-fit rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-950 dark:text-red-400">
                        이동시간 초과
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="shrink-0 p-4 pt-0">
        <button
          type="button"
          disabled={!previewCandidate || !previewCandidate.withinMaxTravel}
          onClick={() => previewId && onSelect(previewId)}
          className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white disabled:opacity-30 dark:bg-white dark:text-black"
        >
          이 장소로 교체
        </button>
      </div>
    </div>
  );
}

/** 지도 위 동선의 가운데에 "도보 N분"을 보여주는 작은 말풍선. */
function WalkBubble({
  from,
  to,
  minutes,
  tone = "blue",
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  minutes: number;
  tone?: "blue" | "green";
}) {
  const label = `도보 ${Math.round(minutes)}분`;
  const width = label.length * 7 + 12;
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2;
  return (
    <g pointerEvents="none">
      <rect
        x={cx - width / 2}
        y={cy - 10}
        width={width}
        height={20}
        rx={10}
        className={
          tone === "green"
            ? "fill-white stroke-emerald-500 dark:fill-zinc-800 dark:stroke-emerald-400"
            : "fill-white stroke-blue-500 dark:fill-zinc-800 dark:stroke-blue-400"
        }
        strokeWidth={1.5}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        className={`text-[11px] font-semibold ${tone === "green" ? "fill-emerald-600 dark:fill-emerald-300" : "fill-blue-600 dark:fill-blue-300"}`}
      >
        {label}
      </text>
    </g>
  );
}

type LatLngLike = { lat: number; lng: number };

function StubMap({
  decidedStages,
  candidates,
  previewPlaceId,
  nextSelected,
  onTapCandidate,
}: {
  decidedStages: StageResult[];
  candidates: RecommendStageResult["candidates"];
  previewPlaceId: string | null;
  nextSelected: Place | DesignatedPlace | null;
  onTapCandidate: (placeId: string) => void;
}) {
  const [zoomPan, zoomSvgRef] = useZoomPan();
  const maps = useNaverMaps();

  const decidedPoints: MapPoint[] = decidedStages
    .filter((s) => s.selected !== null)
    .map((s) => ({
      lat: s.selected!.lat,
      lng: s.selected!.lng,
      name: s.selected!.name,
    }));

  const allPoints: MapPoint[] = [
    ...decidedPoints,
    ...candidates.map((c) => ({
      lat: c.place.lat,
      lng: c.place.lng,
      name: c.place.name,
    })),
    ...(nextSelected
      ? [
          {
            lat: nextSelected.lat,
            lng: nextSelected.lng,
            name: nextSelected.name,
          },
        ]
      : []),
  ];

  if (allPoints.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-900">
        표시할 위치가 없어요.
      </div>
    );
  }

  if (maps === "ready") {
    const previewCand =
      candidates.find((c) => c.place.id === previewPlaceId) ?? null;
    const last = decidedPoints[decidedPoints.length - 1] ?? null;
    const mid = (a: LatLngLike, b: LatLngLike) => ({
      lat: (a.lat + b.lat) / 2,
      lng: (a.lng + b.lng) / 2,
    });
    const markers: MapMarker[] = [
      ...decidedPoints.map((p, i) => ({
        id: `d${i}`,
        lat: p.lat,
        lng: p.lng,
        kind: "number" as const,
        text: String(i + 1),
        label: p.name,
        gray: true,
      })),
      ...(nextSelected
        ? [
            {
              id: "next",
              lat: nextSelected.lat,
              lng: nextSelected.lng,
              kind: "ghost" as const,
              label: nextSelected.name,
            },
          ]
        : []),
      ...candidates.map((c) => {
        const isPreview = c.place.id === previewPlaceId;
        return {
          id: c.place.id,
          lat: c.place.lat,
          lng: c.place.lng,
          kind: isPreview ? ("preview" as const) : ("candidate" as const),
          label: isPreview ? c.place.name : undefined,
          dim: !isPreview && !c.withinMaxTravel,
          onClick: () => onTapCandidate(c.place.id),
        };
      }),
    ];
    const lines: MapLine[] = [];
    const bubbles: MapBubble[] = [];
    if (decidedPoints.length > 1)
      lines.push({ id: "decided", path: decidedPoints, color: "#a1a1aa" });
    if (last && previewCand) {
      lines.push({
        id: "to-preview",
        path: [last, previewCand.place],
        color: "#3b82f6",
        dashed: true,
      });
      bubbles.push({
        id: "b1",
        ...mid(last, previewCand.place),
        text: `도보 ${Math.round(walkingMinutesBetween(last, previewCand.place))}분`,
      });
    }
    if (previewCand && nextSelected) {
      lines.push({
        id: "to-next",
        path: [previewCand.place, nextSelected],
        color: "#3b82f6",
        dashed: true,
      });
      bubbles.push({
        id: "b2",
        ...mid(previewCand.place, nextSelected),
        text: `도보 ${Math.round(walkingMinutesBetween(previewCand.place, nextSelected))}분`,
      });
    }
    return (
      <NaverMapCanvas
        ariaLabel="네이버 지도(후보 장소)"
        markers={markers}
        lines={lines}
        bubbles={bubbles}
        fitKey={allPoints.map((p) => `${p.lat},${p.lng}`).join("|")}
      />
    );
  }

  const bounds = computeMapBounds(allPoints);
  const decidedProjected = decidedPoints.map((p) => projectToMap(p, bounds));
  const lastDecided = decidedProjected[decidedProjected.length - 1] ?? null;
  const previewPoint =
    candidates.find((c) => c.place.id === previewPlaceId) ?? null;
  const previewProjected = previewPoint
    ? projectToMap(previewPoint.place, bounds)
    : null;
  const nextProjected = nextSelected
    ? projectToMap(nextSelected, bounds)
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
      <svg
        ref={zoomSvgRef}
        viewBox={`0 0 ${MAP_VIEW_SIZE} ${MAP_VIEW_SIZE}`}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{
          touchAction: "none",
          transform: `translate(${zoomPan.translate.x}px, ${zoomPan.translate.y}px) scale(${zoomPan.scale})`,
          transformOrigin: "0 0",
        }}
        {...zoomPan.handlers}
      >
        {decidedProjected.length > 1 && (
          <polyline
            points={decidedProjected.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            className="text-zinc-400 dark:text-zinc-500"
          />
        )}

        {lastDecided && previewProjected && (
          <line
            x1={lastDecided.x}
            y1={lastDecided.y}
            x2={previewProjected.x}
            y2={previewProjected.y}
            stroke="currentColor"
            strokeWidth={2.5}
            strokeDasharray="6 4"
            className="text-blue-500 dark:text-blue-400"
          />
        )}
        {previewProjected && nextProjected && (
          <line
            x1={previewProjected.x}
            y1={previewProjected.y}
            x2={nextProjected.x}
            y2={nextProjected.y}
            stroke="currentColor"
            strokeWidth={2.5}
            strokeDasharray="6 4"
            className="text-blue-500 dark:text-blue-400"
          />
        )}

        {decidedPoints.map((point, i) => {
          const p = decidedProjected[i];
          return (
            <g key={`decided-${i}`}>
              <circle
                cx={p.x}
                cy={p.y}
                r={10}
                className="fill-zinc-500 dark:fill-zinc-400"
              />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                className="fill-white text-[11px] font-bold dark:fill-black"
              >
                {i + 1}
              </text>
              <text
                x={p.x}
                y={p.y - 16}
                textAnchor="middle"
                className="fill-zinc-600 text-[11px] dark:fill-zinc-300"
              >
                {point.name}
              </text>
            </g>
          );
        })}

        {nextProjected && nextSelected && (
          <g opacity={0.5}>
            <circle
              cx={nextProjected.x}
              cy={nextProjected.y}
              r={9}
              className="fill-zinc-400 dark:fill-zinc-600"
            />
            <text
              x={nextProjected.x}
              y={nextProjected.y - 14}
              textAnchor="middle"
              className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
            >
              {nextSelected.name}
            </text>
          </g>
        )}

        {candidates.map((candidate) => {
          const p = projectToMap(candidate.place, bounds);
          const isPreview = candidate.place.id === previewPlaceId;
          return (
            <g
              key={candidate.place.id}
              onClick={() => onTapCandidate(candidate.place.id)}
              className="cursor-pointer"
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={isPreview ? 9 : 7}
                strokeWidth={2}
                className={
                  isPreview
                    ? "fill-blue-500 stroke-white dark:stroke-black"
                    : candidate.withinMaxTravel
                      ? "fill-white stroke-zinc-500 dark:fill-zinc-800 dark:stroke-zinc-400"
                      : "fill-white stroke-zinc-300 opacity-50 dark:fill-zinc-800 dark:stroke-zinc-700"
                }
              />
            </g>
          );
        })}

        {lastDecided && previewProjected && previewPoint && (
          <WalkBubble
            from={lastDecided}
            to={previewProjected}
            minutes={walkingMinutesBetween(
              decidedPoints[decidedPoints.length - 1],
              previewPoint.place,
            )}
          />
        )}
        {previewProjected && previewPoint && nextProjected && nextSelected && (
          <WalkBubble
            from={previewProjected}
            to={nextProjected}
            minutes={walkingMinutesBetween(previewPoint.place, nextSelected)}
          />
        )}
      </svg>

      {zoomPan.isZoomed && <ZoomResetButton onClick={zoomPan.reset} />}

      <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-400 dark:text-zinc-500">
        지도 임시 표시 · 네이버맵 연동 전
      </p>
    </div>
  );
}

function RouteMap({
  stages,
  avatarPoint,
  showApproach = false,
}: {
  stages: StageResult[];
  avatarPoint?: { lat: number; lng: number } | null;
  /** true면 내 위치에서 첫 장소(코스 시작지)까지 가는 길 안내 동선을 점선으로 함께 그린다. */
  showApproach?: boolean;
}) {
  const [zoomPan, zoomSvgRef] = useZoomPan();
  const maps = useNaverMaps();

  const points: MapPoint[] = stages
    .filter((s) => s.selected !== null)
    .map((s) => ({
      lat: s.selected!.lat,
      lng: s.selected!.lng,
      name: s.selected!.name,
    }));

  // 구간마다 도로 경로선을 받아온다(실패하면 직선). 내 위치 → 코스 시작지 구간도 포함.
  const legPairs = points.slice(1).map((p, i) => ({ from: points[i], to: p }));
  const approachLeg =
    showApproach && avatarPoint && points[0]
      ? { from: avatarPoint, to: points[0], coarse: true }
      : null;
  const roadPaths = useRoadPaths(
    approachLeg ? [...legPairs, approachLeg] : legPairs,
    maps === "ready",
  );

  if (points.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-900">
        표시할 위치가 없어요.
      </div>
    );
  }

  const avatarMapPoint: MapPoint | null = avatarPoint
    ? { ...avatarPoint, name: "나" }
    : null;
  if (maps === "ready") {
    const rawLines: MapLine[] = [];
    const rawBubbles: (MapBubble & { lineId: string; viaRoad: boolean })[] = [];
    const addLeg = (
      id: string,
      from: LatLngLike,
      to: LatLngLike,
      road: { path: LatLngLike[]; minutes: number | null } | null,
      color: string,
      dashed: boolean,
    ) => {
      const path = road ? [from, ...road.path, to] : [from, to];
      rawLines.push({ id, path, color, dashed });
      rawBubbles.push({
        id: `b-${id}`,
        lineId: id,
        viaRoad: !!road,
        lat: 0,
        lng: 0,
        // TMAP이 알려준 실제 도보 시간이 있으면 그 값을, 없으면 직선거리 기준 추정값을 쓴다.
        text: `도보 ${Math.round(road?.minutes ?? walkingMinutesBetween(from, to))}분`,
        color: dashed ? color : undefined,
      });
    };
    legPairs.forEach((leg, i) =>
      addLeg(`leg${i}`, leg.from, leg.to, roadPaths[i], "#3b82f6", false),
    );
    if (approachLeg)
      addLeg(
        "approach",
        approachLeg.from,
        approachLeg.to,
        roadPaths[legPairs.length],
        "#10b981",
        true,
      );
    // 같은 길 위에 겹치는 동선은 조금씩 옆으로 벌려 그린다. 말풍선도 옮긴 선 위에 둔다.
    const lines = separateOverlaps(rawLines);
    const bubbles: MapBubble[] = rawBubbles.map(
      ({ lineId, viaRoad, ...bubble }) => {
        const path = lines.find((l) => l.id === lineId)!.path;
        const m = viaRoad
          ? path[Math.floor(path.length / 2)]
          : {
              lat: (path[0].lat + path[path.length - 1].lat) / 2,
              lng: (path[0].lng + path[path.length - 1].lng) / 2,
            };
        return { ...bubble, lat: m.lat, lng: m.lng };
      },
    );
    const markers: MapMarker[] = [
      ...points.map((p, i) => ({
        id: `p${i}`,
        lat: p.lat,
        lng: p.lng,
        kind: "number" as const,
        text: String(i + 1),
        label: p.name,
      })),
      ...(avatarPoint
        ? [{ id: "me", ...avatarPoint, kind: "avatar" as const }]
        : []),
    ];
    return (
      <NaverMapCanvas
        ariaLabel="네이버 지도(코스)"
        markers={markers}
        lines={lines}
        bubbles={bubbles}
        fitKey={points.map((p) => `${p.lat},${p.lng}`).join("|")}
      />
    );
  }

  const bounds = computeMapBounds(
    avatarMapPoint ? [...points, avatarMapPoint] : points,
  );
  const projected = points.map((p) => projectToMap(p, bounds));
  const avatarProjected = avatarMapPoint
    ? projectToMap(avatarMapPoint, bounds)
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
      <svg
        ref={zoomSvgRef}
        viewBox={`0 0 ${MAP_VIEW_SIZE} ${MAP_VIEW_SIZE}`}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{
          touchAction: "none",
          transform: `translate(${zoomPan.translate.x}px, ${zoomPan.translate.y}px) scale(${zoomPan.scale})`,
          transformOrigin: "0 0",
        }}
        {...zoomPan.handlers}
      >
        {projected.length > 1 && (
          <polyline
            points={projected.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            className="text-blue-500 dark:text-blue-400"
          />
        )}

        {showApproach && avatarProjected && avatarMapPoint && (
          <>
            <line
              x1={avatarProjected.x}
              y1={avatarProjected.y}
              x2={projected[0].x}
              y2={projected[0].y}
              stroke="currentColor"
              strokeWidth={3}
              strokeDasharray="6 5"
              className="text-emerald-500 dark:text-emerald-400"
            />
            <WalkBubble
              from={avatarProjected}
              to={projected[0]}
              minutes={walkingMinutesBetween(avatarMapPoint, points[0])}
              tone="green"
            />
          </>
        )}

        {projected.slice(1).map((end, i) => (
          <WalkBubble
            key={`leg-${i}`}
            from={projected[i]}
            to={end}
            minutes={walkingMinutesBetween(points[i], points[i + 1])}
          />
        ))}

        {points.map((point, i) => {
          const p = projected[i];
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={10} className="fill-blue-500" />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                className="fill-white text-[11px] font-bold"
              >
                {i + 1}
              </text>
              <text
                x={p.x}
                y={p.y - 16}
                textAnchor="middle"
                className="fill-zinc-600 text-[11px] dark:fill-zinc-300"
              >
                {point.name}
              </text>
            </g>
          );
        })}

        {avatarProjected && (
          <g>
            <circle
              cx={avatarProjected.x}
              cy={avatarProjected.y}
              r={16}
              className="fill-blue-500/10 stroke-blue-400/40"
              strokeWidth={2}
            />
            <text
              x={avatarProjected.x}
              y={avatarProjected.y + 7}
              textAnchor="middle"
              fontSize={20}
            >
              🧍
            </text>
          </g>
        )}
      </svg>

      {zoomPan.isZoomed && <ZoomResetButton onClick={zoomPan.reset} />}

      <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-400 dark:text-zinc-500">
        지도 임시 표시 · 네이버맵 연동 전
      </p>
    </div>
  );
}

function NavigateView({
  result,
  avatarPoint,
  locationKnown,
  onBack,
  onEnd,
}: {
  result: CourseResult;
  avatarPoint: { lat: number; lng: number };
  /** false면 위치 권한이 없어 종로 중심을 내 위치로 대신 쓰는 중. */
  locationKnown: boolean;
  onBack: () => void;
  onEnd: () => void;
}) {
  // 체크하면 "내 위치 → 코스 시작지" 길 안내 동선을 끈다(기본은 켜짐).
  const [approachOff, setApproachOff] = useState(false);
  // 내 위치 → 코스 시작지(첫 장소) 도보 길 안내. RouteMap이 같은 구간을 그리므로 같은 캐시를 쓴다.
  const maps = useNaverMaps();
  const origin = result.stages.find((s) => s.selected !== null)?.selected;
  const approach = useRoadPaths(
    origin ? [{ from: avatarPoint, to: origin, coarse: true }] : [],
    maps === "ready" && !!origin,
  )[0];
  const progress =
    approach && !approachOff
      ? computeProgress(
          approach.path,
          approach.steps,
          avatarPoint,
          approach.minutes,
        )
      : null;
  // 뒤로가기를 누르면 "안내를 멈출까요?" 확인 창을 먼저 띄운다.
  const [askStop, setAskStop] = useState(false);
  // 종료를 누르면 "안내를 종료할까요?" → "추억에 저장할까요?" 순서로 묻는다.
  const [askEnd, setAskEnd] = useState(false);
  const [askMemory, setAskMemory] = useState(false);
  const [memoryFailed, setMemoryFailed] = useState(false);

  return (
    <div className="relative h-screen w-full bg-white dark:bg-black">
      <RouteMap
        stages={result.stages}
        avatarPoint={avatarPoint}
        showApproach={!approachOff}
      />

      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAskStop(true)}
            className="h-10 rounded-full border border-zinc-300 bg-white/90 px-4 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200"
          >
            뒤로가기
          </button>
          <button
            type="button"
            onClick={() => setAskEnd(true)}
            className="h-10 rounded-full bg-black px-4 text-sm font-medium text-white shadow-sm dark:bg-white dark:text-black"
          >
            종료
          </button>
        </div>
        <label className="flex h-9 items-center gap-2 rounded-full border border-zinc-300 bg-white/90 px-3 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200">
          <input
            type="checkbox"
            checked={approachOff}
            onChange={(e) => setApproachOff(e.target.checked)}
            className="h-4 w-4"
          />
          코스 시작지까지 동선 끄기
        </label>
      </div>

      {!approachOff && origin && (
        <div
          role="status"
          aria-label="코스 시작지까지 길 안내"
          className="absolute inset-x-3 bottom-3 z-10 rounded-2xl bg-white/95 p-4 shadow-lg dark:bg-zinc-900/95"
        >
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            코스 시작지({origin.name})까지 길 안내
            {!locationKnown && " · 위치 권한이 없어 고른 지역 중심에서 안내 중"}
          </p>
          {!progress ? (
            <p className="mt-1 text-base font-semibold text-black dark:text-white">
              길을 찾는 중이에요…
            </p>
          ) : progress.arrived ? (
            <p className="mt-1 text-lg font-bold text-black dark:text-white">
              📍 코스 시작지에 도착했어요
            </p>
          ) : (
            <>
              <p className="mt-1 flex items-center gap-2 text-lg font-bold text-black dark:text-white">
                <span aria-hidden>
                  {progress.next ? turnIcon(progress.next.step.turn) : "⬆️"}
                </span>
                <span>
                  {progress.next
                    ? `${formatMeters(progress.next.meters)} 앞 · ${progress.next.step.text}`
                    : "길을 따라 계속 가세요"}
                </span>
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                남은 거리 {formatMeters(progress.remainingMeters)} · 약{" "}
                {Math.max(1, Math.round(progress.remainingMinutes))}분
              </p>
              {progress.offRoute && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  길에서 벗어났어요. 새 길을 찾는 중이에요…
                </p>
              )}
            </>
          )}
        </div>
      )}

      {askEnd && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setAskEnd(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="안내 종료 확인"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <h2 className="text-lg font-bold text-black dark:text-white">
              안내를 종료할까요?
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAskEnd(false);
                  setMemoryFailed(false);
                  setAskMemory(true);
                }}
                className="h-12 flex-1 rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
              >
                예
              </button>
              <button
                type="button"
                onClick={() => setAskEnd(false)}
                className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
              >
                아니오
              </button>
            </div>
          </div>
        </div>
      )}

      {askMemory && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setAskMemory(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="추억 저장 확인"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-bold text-black dark:text-white">
                추억에 저장할까요?
              </h2>
              <button
                type="button"
                onClick={() => setAskMemory(false)}
                aria-label="닫기"
                className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
              >
                ✕
              </button>
            </div>
            {memoryFailed && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const course = toSavedCourse(result);
                  if (course && saveCourse(course)) {
                    setAskMemory(false);
                    onEnd();
                  } else {
                    setMemoryFailed(true);
                  }
                }}
                className="h-12 flex-1 rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
              >
                예
              </button>
              <button
                type="button"
                onClick={() => {
                  setAskMemory(false);
                  onEnd();
                }}
                className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
              >
                아니오
              </button>
            </div>
          </div>
        </div>
      )}

      {askStop && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-6"
          onClick={() => setAskStop(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="안내 멈춤 확인"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <h2 className="text-lg font-bold text-black dark:text-white">
              안내를 멈출까요?
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAskStop(false);
                  onBack();
                }}
                className="h-12 flex-1 rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
              >
                예
              </button>
              <button
                type="button"
                onClick={() => setAskStop(false)}
                className="h-12 flex-1 rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
              >
                아니오
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type LocationStatus = "idle" | "loading" | "granted" | "denied" | "unsupported";

export default function Home() {
  // checking: 로그인 상태 확인 중, out: 로그인 화면, in: 로그인(또는 둘러보기) 완료
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");
  const [loginError, setLoginError] = useState(false);

  useEffect(() => {
    // 네이버 로그인 후 돌아왔는지(쿠키) 서버에 물어본다. 실패해도 로그인 화면으로 간다.
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { user: null }))
      .catch(() => ({ user: null }))
      .then((data: { user: { name: string } | null }) => {
        const params = new URLSearchParams(window.location.search);
        if (params.get("login") === "error") {
          setLoginError(true);
          window.history.replaceState(null, "", "/");
        }
        setAuth(data.user ? "in" : "out");
      });
  }, []);

  if (auth === "checking") {
    return <div className="h-screen w-full bg-white dark:bg-black" />;
  }

  if (auth === "out") {
    return (
      <LoginScreen loginError={loginError} onGuest={() => setAuth("in")} />
    );
  }

  return <CourseBuilder />;
}

function LoginScreen({
  loginError,
  onGuest,
}: {
  loginError: boolean;
  onGuest: () => void;
}) {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-10 bg-white px-6 dark:bg-black">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-bold text-black dark:text-white">
          코스 추천
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          지역과 일정 순서를 정하면 평점과 동선을 고려해 코스를 이어드려요
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        {loginError && (
          <p
            role="alert"
            className="text-center text-sm text-red-600 dark:text-red-400"
          >
            네이버 로그인에 실패했어요. 다시 시도해 주세요.
          </p>
        )}
        <a
          href="/api/auth/naver/login"
          className="flex h-14 w-full items-center justify-center rounded-xl bg-[#03C75A] text-base font-semibold text-white"
        >
          네이버로 로그인
        </a>
        <button
          type="button"
          onClick={onGuest}
          className="h-14 w-full rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          로그인 없이 둘러보기
        </button>
      </div>
    </div>
  );
}

/** 아직 지도 없이, 여행을 기다리며 앉아있는 내 아바타를 보여주는 임시 장면. */
function AvatarScene({
  status,
  onOpenGroup,
}: {
  status: LocationStatus;
  onOpenGroup: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [avatar, setAvatar] = useState<Avatar>(DEFAULT_AVATAR);

  useEffect(() => {
    // localStorage는 브라우저에서만 읽을 수 있어 마운트 후에 한 번 불러온다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvatar(loadAvatar());
  }, []);

  const statusText =
    status === "loading"
      ? "내 위치 확인하는 중..."
      : status === "denied"
        ? "위치 권한 없음"
        : status === "unsupported"
          ? "위치 확인 미지원"
          : "";

  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-b from-sky-300 via-sky-200 to-amber-100 dark:from-slate-800 dark:via-slate-700 dark:to-amber-950">
      <span className="absolute left-[12%] top-[14%] text-3xl opacity-80">
        ☁️
      </span>
      <span className="absolute left-[60%] top-[8%] text-2xl opacity-70">
        ☁️
      </span>

      <span className="absolute bottom-[32%] left-[4%] text-6xl drop-shadow">
        🌴
      </span>

      <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-b from-amber-100 to-amber-200 dark:from-amber-900 dark:to-amber-950" />
      <div className="absolute inset-x-0 bottom-0 h-[8%] bg-sky-200/70 dark:bg-sky-900/50" />

      <span className="absolute bottom-[14%] left-[58%] text-3xl">🔥</span>
      <span className="absolute bottom-[11%] left-[57%] text-xl">🪵</span>

      <div className="absolute bottom-[13%] left-[40%] flex flex-col items-center">
        <AvatarFigure avatar={avatar} />
        <span className="-mt-1 text-2xl">🪵</span>
      </div>

      {statusText && (
        <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-black/50 dark:text-white/50">
          {statusText}
        </p>
      )}

      <div className="absolute right-2 top-2 flex gap-1.5">
        <button
          type="button"
          aria-label="친구 추가"
          onClick={() => setFriendsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-sm shadow-sm dark:bg-black/40"
        >
          👤
        </button>
        <button
          type="button"
          aria-label="설정"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-sm shadow-sm dark:bg-black/40"
        >
          ⚙️
        </button>
        <button
          type="button"
          aria-label="아바타 꾸미기"
          onClick={() => setCustomizeOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-sm shadow-sm dark:bg-black/40"
        >
          {avatar.character}
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenGroup}
        className="absolute right-0 top-1/2 flex h-10 -translate-y-1/2 items-center gap-1 rounded-l-full bg-white/80 pl-3 pr-2 text-xs font-medium text-zinc-700 shadow-sm dark:bg-black/40 dark:text-zinc-200"
      >
        그룹으로 <span aria-hidden>▶</span>
      </button>

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {friendsOpen && <FriendsSheet onClose={() => setFriendsOpen(false)} />}
      {customizeOpen && (
        <AvatarCustomizer
          initial={avatar}
          onChange={setAvatar}
          onClose={() => setCustomizeOpen(false)}
        />
      )}
    </div>
  );
}

/** 이 기기에서 처음 한 번 만들어 localStorage에 저장해두는 개인 코드. 서버·로그인이 없어서 기기마다 다르다. */
function loadOrCreatePersonalCode(): string {
  try {
    const saved = window.localStorage.getItem(PERSONAL_CODE_STORAGE_KEY);
    if (saved) return saved;
  } catch {
    // 저장소를 못 읽어도 아래에서 새로 만든다.
  }
  const bytes = new Uint8Array(PERSONAL_CODE_LENGTH);
  window.crypto.getRandomValues(bytes);
  const code = Array.from(
    bytes,
    (b) => PERSONAL_CODE_CHARS[b % PERSONAL_CODE_CHARS.length],
  ).join("");
  try {
    window.localStorage.setItem(PERSONAL_CODE_STORAGE_KEY, code);
  } catch {
    // 저장에 실패하면 이번 화면에서만 쓰이는 코드가 된다.
  }
  return code;
}

function loadCodeList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}

function saveCodeList(key: string, codes: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(codes));
  } catch {
    // 저장에 실패해도 이번 화면에서는 목록이 보인다.
  }
}

function FriendsSheet({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<"main" | "requests">("main");
  const [requests, setRequests] = useState<string[]>([]);
  const [friends, setFriends] = useState<string[]>([]);
  const [myCode, setMyCode] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    // localStorage는 브라우저에서만 읽을 수 있어 마운트 후에 한 번 불러온다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFriends(loadCodeList(FRIENDS_STORAGE_KEY));
    setRequests(loadCodeList(FRIEND_REQUESTS_STORAGE_KEY));
    setMyCode(loadOrCreatePersonalCode());
  }, []);

  function save(next: string[]) {
    setFriends(next);
    saveCodeList(FRIENDS_STORAGE_KEY, next);
  }

  function saveRequests(next: string[]) {
    setRequests(next);
    saveCodeList(FRIEND_REQUESTS_STORAGE_KEY, next);
  }

  function accept(code: string) {
    if (!friends.includes(code)) save([...friends, code]);
    saveRequests(requests.filter((c) => c !== code));
  }

  function reject(code: string) {
    saveRequests(requests.filter((c) => c !== code));
  }

  // 서버가 없어 진짜 요청은 올 수 없으므로, 요청 화면을 눌러볼 수 있게 임시 요청을 하나 만든다.
  function receiveSampleRequest() {
    const taken = new Set([...friends, ...requests, myCode]);
    for (let i = 0; i < 20; i++) {
      const code = Array.from(
        { length: PERSONAL_CODE_LENGTH },
        () =>
          PERSONAL_CODE_CHARS[
            Math.floor(Math.random() * PERSONAL_CODE_CHARS.length)
          ],
      ).join("");
      if (!taken.has(code)) {
        saveRequests([...requests, code]);
        return;
      }
    }
  }

  function add() {
    const code = input.trim().toUpperCase();
    if (code.length !== PERSONAL_CODE_LENGTH) {
      setError(`개인 코드는 ${PERSONAL_CODE_LENGTH}자리예요.`);
    } else if ([...code].some((ch) => !PERSONAL_CODE_CHARS.includes(ch))) {
      setError(
        "코드에 쓸 수 없는 글자가 있어요. 영문 대문자와 숫자만 입력해주세요.",
      );
    } else if (code === myCode) {
      setError("내 코드는 추가할 수 없어요.");
    } else if (friends.includes(code)) {
      setError("이미 추가된 친구예요.");
    } else {
      save([...friends, code]);
      setInput("");
      setError("");
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex max-h-[70vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {view === "main" ? "친구 추가하기" : "친구 요청"}
          </h2>
          <button
            type="button"
            onClick={view === "main" ? onClose : () => setView("main")}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            {view === "main" ? "✕" : "←"}
          </button>
        </div>

        {view === "requests" && (
          <div className="flex flex-col gap-2">
            {requests.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                받은 친구 요청이 없어요.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {requests.map((code) => (
                  <li
                    key={code}
                    className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700"
                  >
                    <span className="text-base font-semibold tracking-widest text-black dark:text-white">
                      🧑 {code}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => accept(code)}
                        className="h-11 flex-1 rounded-lg bg-black text-sm font-semibold text-white dark:bg-white dark:text-black"
                      >
                        수락
                      </button>
                      <button
                        type="button"
                        onClick={() => reject(code)}
                        className="h-11 flex-1 rounded-lg border border-zinc-300 text-sm font-medium text-black dark:border-zinc-700 dark:text-white"
                      >
                        거절
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {view === "main" && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                maxLength={PERSONAL_CODE_LENGTH}
                placeholder="친구의 개인 코드"
                autoCapitalize="characters"
                className="h-12 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-base uppercase tracking-widest text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
              />
              <button
                type="button"
                onClick={add}
                className="h-12 rounded-lg bg-black px-4 text-sm font-semibold text-white dark:bg-white dark:text-black"
              >
                추가
              </button>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        )}

        {view === "main" && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setView("requests")}
              className="flex h-12 w-full items-center justify-between rounded-lg border border-zinc-300 px-3 text-base text-black dark:border-zinc-700 dark:text-white"
            >
              <span>친구 요청</span>
              <span className="flex items-center gap-2">
                {requests.length > 0 && (
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white">
                    {requests.length}
                  </span>
                )}
                <span aria-hidden>›</span>
              </span>
            </button>
            <button
              type="button"
              onClick={receiveSampleRequest}
              className="h-9 self-start px-1 text-xs text-zinc-400 underline dark:text-zinc-500"
            >
              체험용: 친구 요청 하나 받아보기
            </button>
          </div>
        )}

        {view === "main" && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              친구 목록 {friends.length > 0 && `(${friends.length})`}
            </span>
            {friends.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                아직 친구가 없어요. 친구의 개인 코드를 입력해 추가해보세요.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {friends.map((code) => (
                  <li
                    key={code}
                    className="flex items-center justify-between rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700"
                  >
                    <span className="text-base font-semibold tracking-widest text-black dark:text-white">
                      🧑 {code}
                    </span>
                    <button
                      type="button"
                      onClick={() => save(friends.filter((c) => c !== code))}
                      aria-label={`${code} 삭제`}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 text-red-500 dark:border-zinc-700"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 아바타 화면의 "그룹으로" 버튼으로 들어오는 그룹 화면. 그룹 이름만 이 기기에 저장한다. */
function GroupView({ onBack }: { onBack: () => void }) {
  const [groups, setGroups] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    // localStorage는 브라우저에서만 읽을 수 있어 마운트 후에 한 번 불러온다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroups(loadCodeList(GROUPS_STORAGE_KEY));
  }, []);

  function save(next: string[]) {
    setGroups(next);
    saveCodeList(GROUPS_STORAGE_KEY, next);
  }

  function add() {
    const name = input.trim();
    if (name.length === 0) {
      setError("그룹 이름을 입력해주세요.");
    } else if (groups.includes(name)) {
      setError("이미 있는 그룹 이름이에요.");
    } else {
      save([...groups, name]);
      setInput("");
      setError("");
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-md flex-col gap-6 overflow-y-auto bg-white px-4 py-6 dark:bg-black">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="뒤로가기"
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg dark:border-zinc-700 dark:text-white"
        >
          ←
        </button>
        <h1 className="text-2xl font-bold text-black dark:text-white">그룹</h1>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          그룹 추가하기
        </h2>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            maxLength={MAX_GROUP_NAME_LENGTH}
            placeholder="그룹 이름"
            className="h-12 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
          <button
            type="button"
            onClick={add}
            className="h-12 rounded-lg bg-black px-4 text-sm font-semibold text-white dark:bg-white dark:text-black"
          >
            추가
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          그룹 목록 {groups.length > 0 && `(${groups.length})`}
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            아직 그룹이 없어요. 이름을 입력해 그룹을 만들어보세요.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {groups.map((name) => (
              <li
                key={name}
                className="flex items-center justify-between rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700"
              >
                <span className="text-base font-semibold text-black dark:text-white">
                  👥 {name}
                </span>
                <button
                  type="button"
                  onClick={() => save(groups.filter((g) => g !== name))}
                  aria-label={`${name} 삭제`}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 text-red-500 dark:border-zinc-700"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [nickname, setNickname] = useState("");
  const [nicknameSaved, setNicknameSaved] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  useEffect(() => {
    // localStorage는 브라우저에서만 읽을 수 있어 마운트 후에 한 번 불러온다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(loadOrCreatePersonalCode());
    setNickname(loadNickname());
  }, []);

  function commitNickname() {
    const trimmed = nickname.trim();
    setNickname(trimmed);
    saveNickname(trimmed);
    setNicknameSaved(true);
    window.setTimeout(() => setNicknameSaved(false), 1500);
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 요청이 실패해도 새로고침하면 로그인 확인부터 다시 한다.
    }
    window.location.reload();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 복사 권한이 없으면 코드를 눈으로 보고 옮길 수 있게 그대로 둔다.
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex w-full max-w-md flex-col gap-4 rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">설정</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="nickname"
            className="text-sm font-medium text-zinc-600 dark:text-zinc-400"
          >
            닉네임
          </label>
          <div className="flex items-center gap-2">
            <input
              id="nickname"
              value={nickname}
              maxLength={MAX_NICKNAME_LENGTH}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNickname();
              }}
              placeholder="닉네임을 입력하세요"
              className="h-12 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 text-base text-black dark:border-zinc-700 dark:text-white"
            />
            <button
              type="button"
              onClick={commitNickname}
              className="h-12 rounded-lg bg-black px-4 text-sm font-semibold text-white dark:bg-white dark:text-black"
            >
              {nicknameSaved ? "저장됨" : "저장"}
            </button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            최대 {MAX_NICKNAME_LENGTH}자예요. 나중에 그룹에서 내 이름으로
            보여요.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            개인 코드
          </span>
          <div className="flex items-center gap-2">
            <div
              aria-label="개인 코드"
              className="flex h-12 flex-1 items-center justify-center rounded-lg border border-zinc-300 text-xl font-bold tracking-[0.3em] text-black dark:border-zinc-700 dark:text-white"
            >
              {code}
            </div>
            <button
              type="button"
              onClick={copy}
              disabled={!code}
              className="h-12 rounded-lg bg-black px-4 text-sm font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {copied ? "복사됨" : "복사"}
            </button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            이 기기에서 만들어진 나만의 코드예요. 나중에 그룹에 참여할 때 쓸 수
            있어요.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setPrivacyOpen(true)}
          className="h-12 w-full rounded-lg border border-zinc-300 text-sm font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          개인정보처리방침
        </button>

        <button
          type="button"
          onClick={logout}
          className="h-12 w-full rounded-lg border border-zinc-300 text-sm font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          로그아웃
        </button>
      </div>
      {privacyOpen && (
        <PrivacyPolicySheet onClose={() => setPrivacyOpen(false)} />
      )}
    </div>
  );
}
