"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import {
  SUB_CATEGORIES,
  places,
  type Place,
  type PlaceCategory,
} from "@/data/places";
import {
  REGION_CENTER,
  buildCourse,
  isWithinRegionRange,
  naverMapLinkFor,
  walkingMinutesBetween,
  type CourseResult,
  type DesignatedPlace,
  type RecommendStageResult,
  type Stage,
  type StageOverrides,
  type StageResult,
} from "@/lib/course";
import { searchPlaces } from "@/lib/placeSearch";
import { buildAiRequest, type AiPicks } from "@/lib/aiRecommend";
import { saveCourse, toSavedCourse } from "@/lib/savedCourses";
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

const CATEGORIES: PlaceCategory[] = [
  "문화 생활",
  "액티비티",
  "맛집",
  "카페",
  "술집",
  "쇼핑",
];

const MIN_TRAVEL_MINUTES = 5;
const TRAVEL_MINUTES_STEP = 5;
const MAX_TRAVEL_MINUTES = 30;
const DEFAULT_TRAVEL_MINUTES = 15;
const MAX_STAGES = 8;
const MAX_RECENT_DESIGNATED = 10;

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

/** "상관없음" 상태의 출발지 장소(아직 장소를 고르지 않음). 추천 계산에는 넣지 않는다. */
const DEFAULT_ORIGIN_PLACE_ID = "default-origin";

function isUnsetStage(stage: Stage): boolean {
  return (
    stage.kind === "designated" && stage.place.id === DEFAULT_ORIGIN_PLACE_ID
  );
}

/**
 * AI가 테마와 장소를 채워 줄 "상관없음" 칸.
 * 출발지의 "상관없음"은 다른 단계가 하나라도 있을 때만 칸으로 센다(없으면 AI가 일정을 통으로 짠다).
 */
function isFillSlot(stage: Stage, all: Stage[]): boolean {
  if (!isUnsetStage(stage)) return false;
  return !stage.isOrigin || all.some((s) => !s.isOrigin);
}

/** AI에게 알려 줄 단계 이름. 추천 단계는 카테고리(+세부), 지정 단계는 장소 이름. */
function describeStageForAi(stage: Stage): string {
  if (stage.kind === "recommend") {
    return stage.subCategory
      ? `${stage.category} / ${stage.subCategory}`
      : stage.category;
  }
  return stage.isOrigin ? `출발지: ${stage.place.name}` : stage.place.name;
}

/** 장소를 아직 고르지 않은 "상관없음" 지정 단계(출발지 기본값, 단계 추가의 "상관없음")를 만든다. */
function unsetPlace(): DesignatedPlace {
  return {
    id: DEFAULT_ORIGIN_PLACE_ID,
    name: "상관없음",
    address: "",
    lat: REGION_CENTER.lat,
    lng: REGION_CENTER.lng,
  };
}

/** 일정 맨 앞에 출발지 단계가 항상 하나 있도록 맞춘다(없으면 "상관없음" 출발지를 앞에 넣고, 여러 개면 첫 번째만 남긴다). */
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
  const [stages, setStages] = useState<Stage[]>([]);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(
    DEFAULT_TRAVEL_MINUTES,
  );
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

  const avatarPoint = location ?? REGION_CENTER;

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
        places,
        maxTravelMinutes,
        overrides,
        planDate,
      ),
    [stages, maxTravelMinutes, overrides, planDate],
  );

  function addRecommendStage(
    category: PlaceCategory,
    subCategory: string | undefined,
  ) {
    setStages((prev) => [
      ...prev,
      { id: generateId("stage"), kind: "recommend", category, subCategory },
    ]);
    setAddSheetOpen(false);
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
        // 추천 단계였던 칸도 장소를 직접 고르면 지정 단계로 바뀐다(출발지 표시는 유지).
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
   * 결과 화면에서 입력 화면으로 돌아간다. 결과 화면에서 바꾼 것(순서·출발지·삭제·추가)과
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

  /** 결과 화면에서 단계를 지운다(출발지도 가능, 지우면 다음 단계가 출발지가 됨). 남은 단계가 없으면 입력 화면으로 돌아간다. */
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
        const baseline = buildCourse(
          filled.filter((s) => !isUnsetStage(s)),
          places,
          maxTravelMinutes,
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
    };
    // 출발지 말고는 단계가 하나도 없을 때만 AI가 단계 수까지 정한다("상관없음" 칸은 칸으로 센다).
    // 출발지만 추천받기로 한 경우(originOnly)에는 뒤 일정을 짜지 않는다.
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
        // 출발지는 그대로 두고, 이어서 AI가 짠 단계를 붙인다(비어 있던 지정 단계는 대체).
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
        const baseline = buildCourse(
          working,
          places,
          maxTravelMinutes,
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

  /** 결과 화면에서 끌어 바꾼 순서를 일정 단계에 반영한다. 맨 위에 온 단계가 출발지가 된다. */
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
          onRequestChangeDesignated={(stageId) =>
            setDesignatedEditTarget(stageId)
          }
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

      {addSheetOpen && (
        <AddStageSheet
          canAddMore={stages.length < MAX_STAGES}
          onClose={() => setAddSheetOpen(false)}
          onAddRecommend={addRecommendStage}
          onAddUnsetDesignated={addUnsetDesignatedStage}
          onStartDesignated={() => setDesignatedEditTarget("new")}
        />
      )}

      {changeStageTarget && (
        <AddStageSheet
          title="단계 변경"
          canAddMore
          onClose={() => setChangeStageTarget(null)}
          onAddRecommend={(category, subCategory) => {
            setStages((prev) =>
              prev.map((s) =>
                s.id === changeStageTarget
                  ? {
                      id: generateId("stage"),
                      kind: "recommend" as const,
                      category,
                      subCategory,
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
}: {
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
}) {
  const [travelPickerOpen, setTravelPickerOpen] = useState(false);
  const [timePicker, setTimePicker] = useState<"start" | "end" | null>(null);
  const hasNote = themeNote.trim().length > 0;

  // 단계가 없으면 AI가 단계부터 짜 주고, 있으면 그 단계로 코스를 만든다.
  const origin = stages.find((s) => s.isOrigin);
  const others = stages.filter((s) => !s.isOrigin);
  const hasOthers = others.some((s) => !isUnsetStage(s));
  const makeLabel = hasOthers
    ? "코스 만들기"
    : hasNote
      ? "이 분위기로 코스 추천받기"
      : "AI에게 코스 추천받기";

  // 출발지 칸만 있고 그 칸이 테마나 장소로 채워져 있으면, 출발지만 추천할지 먼저 묻는다.
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
            지역
          </label>
          <div className="flex h-12 w-full items-center rounded-xl border border-zinc-300 bg-zinc-50 px-4 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white">
            종로
          </div>
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
                • 출발지 칸만 있고 다른 단계가 없으면, 나머지 일정은 AI가 통째로
                추천해요.
              </li>
              <li>• 왼쪽 ⠿ 버튼을 잡고 끌면 순서를 바꿀 수 있어요.</li>
              <li>• &lsquo;상관없음&rsquo;으로 두면 그 칸은 AI가 채워줘요.</li>
            </ul>
          </HelpTip>
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
          aria-label={`구간별 최대 이동시간 ${maxTravelMinutes}분, 눌러서 바꾸기`}
          className="flex h-11 items-center gap-1 rounded-lg border border-zinc-300 px-4 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          {maxTravelMinutes}분 <span aria-hidden>▾</span>
        </button>
      </section>

      {travelPickerOpen && (
        <ScrollPickerSheet
          title="구간별 최대 이동시간"
          testId="travel-picker"
          options={TRAVEL_OPTIONS.map((m) => ({ value: m, label: `${m}분` }))}
          value={maxTravelMinutes}
          onConfirm={(minutes) => {
            onSetMaxTravelMinutes(minutes);
            setTravelPickerOpen(false);
          }}
          onClose={() => setTravelPickerOpen(false)}
        />
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
            aria-label="출발지만 추천"
            className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-5 dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-bold text-black dark:text-white">
                출발지만 추천해드릴까요?
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
              &lsquo;아니오&rsquo;를 누르면 출발지 뒤의 일정도 AI가 이어서
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
        <div className="basis-full rounded-lg bg-zinc-100 px-3 py-3 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
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

/** 예전에 1분 단위로 저장된 값을 가장 가까운 5분 단위로 맞춘다. */
function snapTravelMinutes(minutes: number): number {
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
  /** 출발지처럼 순서를 옮기거나 지울 수 없는 단계. */
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
              출발지
            </span>
          )}
          <span className="text-base font-medium text-black dark:text-white">
            {stage.kind === "recommend"
              ? `${stage.category}${stage.subCategory ? ` · ${stage.subCategory}` : ""}`
              : isUnsetStage(stage)
                ? "상관없음"
                : stage.place.name}
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

function AddStageSheet({
  canAddMore,
  onClose,
  onAddRecommend,
  onStartDesignated,
  onAddUnsetDesignated,
  title = "단계 추가",
}: {
  canAddMore: boolean;
  onClose: () => void;
  onAddRecommend: (
    category: PlaceCategory,
    subCategory: string | undefined,
  ) => void;
  onStartDesignated: () => void;
  onAddUnsetDesignated: () => void;
  title?: string;
}) {
  // 카테고리를 고르면, 세부 카테고리가 있는 항목(맛집·카페)만 한 번 더 고르고 나머지는 바로 추가한다.
  const [category, setCategory] = useState<PlaceCategory | null>(null);

  function pickCategory(c: PlaceCategory) {
    if (SUB_CATEGORIES[c].length > 0) {
      setCategory(c);
    } else {
      onAddRecommend(c, undefined);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex max-h-[70vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">
            {category ? `${category} 세부 카테고리` : title}
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

        {canAddMore && category === null && (
          <div className="flex flex-col gap-3">
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
            {
              <div className="grid grid-cols-2 gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pickCategory(c)}
                    className="flex h-14 items-center justify-center rounded-xl border border-zinc-300 text-base font-medium text-black dark:border-zinc-700 dark:text-white"
                  >
                    {c}
                  </button>
                ))}
              </div>
            }
          </div>
        )}

        {canAddMore && category !== null && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onAddRecommend(category, undefined)}
              className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
            >
              상관없음
            </button>
            <div className="grid grid-cols-2 gap-2">
              {SUB_CATEGORIES[category].map((sub) => (
                <button
                  key={sub}
                  type="button"
                  onClick={() => onAddRecommend(category, sub)}
                  className="h-12 rounded-xl border border-zinc-300 text-base text-black dark:border-zinc-700 dark:text-white"
                >
                  {sub}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCategory(null)}
              className="h-11 w-full text-sm text-zinc-500 dark:text-zinc-400"
            >
              ← 다른 카테고리 고르기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DesignatedPlaceSheet({
  initial,
  recentPlaces,
  onClose,
  onSubmit,
}: {
  initial: DesignatedPlace | null;
  recentPlaces: DesignatedPlace[];
  onClose: () => void;
  onSubmit: (place: DesignatedPlace) => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchPlaces(query), [query]);
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
            placeholder="장소 이름 (예: 안국역)"
            aria-label="장소 이름"
            className="h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
          {initial && !hasQuery && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              지금 지정된 장소: {initial.name}
            </p>
          )}
        </div>

        {hasQuery ? (
          results.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              검색 결과가 없어요. 다른 이름으로 검색해보세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {results.map((p) => {
                const outside = !isWithinRegionRange(p);
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
                      {outside && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          종로 일대 밖 · 코스에는 들어가지만 주변 추천은 종로
                          일대에서만 돼요
                        </span>
                      )}
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
          지금은 종로 일대 대표 장소와 예시 장소 안에서만 검색돼요. 네이버 키를
          연결하면 실제 장소 검색으로 바뀌어요.
        </p>
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

function ResultView({
  result,
  avatarPoint,
  onBack,
  onReplace,
  onRequestChangeDesignated,
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
  onRequestChangeDesignated: (stageId: string) => void;
  /** 모든 단계 id를 새 순서대로 넘긴다(맨 위가 출발지가 된다). */
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
          <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1">
                {handle}
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
                ★ {stageResult.selected.rating.toFixed(1)} · 리뷰{" "}
                {stageResult.selected.reviewCount.toLocaleString()}개
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
          <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-1 items-center gap-1">
                {handle}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-lg font-semibold text-black dark:text-white">
                    {stageResult.selected.name}
                  </span>
                  {!stageResult.stage.isOrigin && (
                    <span className="w-fit rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200">
                      지정
                    </span>
                  )}
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
                onClick={() => onRequestChangeDesignated(stageResult.stage.id)}
                className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
              >
                변경
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

      {!result.success ? (
        <div className="mx-auto w-full max-w-md px-4 pb-6">
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <p className="text-base text-zinc-600 dark:text-zinc-300">
              {failedIndex + 1}번째 단계에서 조건에 맞는 곳을 찾지 못했어요.
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
                테마(▾)를 누르면 바꿀 수 있어요
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
    } else if (pointers.current.size === 1 && panRef.current && scale > 1) {
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
      isZoomed: scale > 1.001,
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
              const nextMinutes = nextSelected
                ? walkingMinutesBetween(candidate.place, nextSelected)
                : null;

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
                        ★ {candidate.place.rating.toFixed(1)}
                      </span>
                    </div>
                    <span className="text-sm text-zinc-500 dark:text-zinc-400">
                      {candidate.travelMinutesFromPrevious !== null &&
                        `이전 장소까지 도보 약 ${Math.round(candidate.travelMinutesFromPrevious)}분`}
                      {candidate.travelMinutesFromPrevious !== null &&
                        nextMinutes !== null &&
                        " · "}
                      {nextMinutes !== null &&
                        `다음 장소까지 도보 약 ${Math.round(nextMinutes)}분`}
                    </span>
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
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  minutes: number;
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
        className="fill-white stroke-blue-500 dark:fill-zinc-800 dark:stroke-blue-400"
        strokeWidth={1.5}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        className="fill-blue-600 text-[11px] font-semibold dark:fill-blue-300"
      >
        {label}
      </text>
    </g>
  );
}

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
        className={`h-full w-full ${zoomPan.scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
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
}: {
  stages: StageResult[];
  avatarPoint?: { lat: number; lng: number } | null;
}) {
  const [zoomPan, zoomSvgRef] = useZoomPan();

  const points: MapPoint[] = stages
    .filter((s) => s.selected !== null)
    .map((s) => ({
      lat: s.selected!.lat,
      lng: s.selected!.lng,
      name: s.selected!.name,
    }));

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
        className={`h-full w-full ${zoomPan.scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
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
  onBack,
  onEnd,
}: {
  result: CourseResult;
  avatarPoint: { lat: number; lng: number };
  onBack: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="relative h-screen w-full bg-white dark:bg-black">
      <RouteMap stages={result.stages} avatarPoint={avatarPoint} />

      <div className="absolute right-3 top-3 flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="h-10 rounded-full border border-zinc-300 bg-white/90 px-4 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200"
        >
          뒤로가기
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="h-10 rounded-full bg-black px-4 text-sm font-medium text-white shadow-sm dark:bg-white dark:text-black"
        >
          종료
        </button>
      </div>
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
