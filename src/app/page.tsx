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

const CATEGORIES: PlaceCategory[] = [
  "문화 생활",
  "액티비티",
  "맛집",
  "카페",
  "술집",
  "쇼핑",
];

const MIN_TRAVEL_MINUTES = 5;
const MAX_TRAVEL_MINUTES = 30;
const DEFAULT_TRAVEL_MINUTES = 15;
const MAX_STAGES = 8;
const MAX_RECENT_DESIGNATED = 10;
/** 아바타 영역이 차지하는 화면 비율(나머지는 코스 만들기 패널). 드래그로 바꿀 수 없는 고정값. */
const AVATAR_FIXED_SHARE = 0.35;

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
  디저트: "디저트 중심",
  브런치: "커피 중심",
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
    return Array.isArray(parsed) ? parsed : [];
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
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) && saved >= today) return saved;
  } catch {
    // 저장소를 못 읽으면 오늘로 둔다.
  }
  return today;
}

const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/** 카드에 보여줄 운영 시간 문구. 예: "10:00–18:00 · 매주 월요일 휴무" */
function formatOpeningHours(place: Place): string {
  const days = place.closedDays.map((d) => `${WEEKDAY_NAMES[d]}요일`).join("·");
  return `${place.openTime}–${place.closeTime} · ${
    days ? `매주 ${days} 휴무` : "휴무일 없음"
  }`;
}

function positionLabel(index: number, total: number): "출발" | "경유" | "도착" {
  if (index === 0) return "출발";
  if (index === total - 1) return "도착";
  return "경유";
}

function CourseBuilder() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(
    DEFAULT_TRAVEL_MINUTES,
  );
  const [planDate, setPlanDate] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [overrides, setOverrides] = useState<StageOverrides>({});
  const [addSheetOpen, setAddSheetOpen] = useState(false);
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
    setStages(last ? dedupeStageIds(last.stages) : []);
    setMaxTravelMinutes(last ? last.maxTravelMinutes : DEFAULT_TRAVEL_MINUTES);
    setRecentDesignated(loadRecentDesignated());
    setPlanDate(loadPlanDate());
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

  const result = useMemo(
    () => buildCourse(stages, places, maxTravelMinutes, overrides, planDate),
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

  function upsertDesignatedStage(place: DesignatedPlace) {
    setStages((prev) => {
      if (designatedEditTarget && designatedEditTarget !== "new") {
        return prev.map((s) =>
          s.id === designatedEditTarget && s.kind === "designated"
            ? { ...s, place }
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
        (p) => !(p.name === place.name && p.address === place.address),
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
    setStages((prev) => prev.filter((s) => s.id !== id));
  }

  function makeCourse() {
    setOverrides({});
    setShowResult(true);
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
          setShowResult(false);
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
          onBack={() => setShowResult(false)}
          onReplace={replaceRecommendStage}
          onRequestChangeDesignated={(stageId) =>
            setDesignatedEditTarget(stageId)
          }
          onDecideRoute={() => setNavigating(true)}
        />
      ) : (
        <div className="flex h-screen w-full flex-col bg-white dark:bg-black">
          <div
            style={{ flexGrow: AVATAR_FIXED_SHARE, flexBasis: 0 }}
            className="min-h-0"
          >
            <AvatarScene
              status={locationStatus}
              onOpenGroup={() => setGroupScreenOpen(true)}
            />
          </div>

          <div
            style={{ flexGrow: 1 - AVATAR_FIXED_SHARE, flexBasis: 0 }}
            className="min-h-0 overflow-hidden"
          >
            <InputView
              stages={stages}
              planDate={planDate}
              onSetPlanDate={setPlanDate}
              maxTravelMinutes={maxTravelMinutes}
              onSetMaxTravelMinutes={setMaxTravelMinutes}
              onOpenAddSheet={() => setAddSheetOpen(true)}
              onRemoveStage={removeStage}
              onReorderStages={setStages}
              onRequestChangeDesignated={(stageId) =>
                setDesignatedEditTarget(stageId)
              }
              onMakeCourse={makeCourse}
            />
          </div>
        </div>
      )}

      {addSheetOpen && (
        <AddStageSheet
          canAddMore={stages.length < MAX_STAGES}
          onClose={() => setAddSheetOpen(false)}
          onAddRecommend={addRecommendStage}
          onStartDesignated={() => setDesignatedEditTarget("new")}
        />
      )}

      {designatedEditTarget && (
        <DesignatedPlaceSheet
          initial={
            editingPlace && editingPlace.kind === "designated"
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
  stages,
  maxTravelMinutes,
  onSetMaxTravelMinutes,
  onOpenAddSheet,
  onRemoveStage,
  onReorderStages,
  onRequestChangeDesignated,
  onMakeCourse,
}: {
  planDate: string;
  onSetPlanDate: (date: string) => void;
  stages: Stage[];
  maxTravelMinutes: number;
  onSetMaxTravelMinutes: (minutes: number) => void;
  onOpenAddSheet: () => void;
  onRemoveStage: (id: string) => void;
  onReorderStages: (stages: Stage[]) => void;
  onRequestChangeDesignated: (stageId: string) => void;
  onMakeCourse: () => void;
}) {
  const [travelPickerOpen, setTravelPickerOpen] = useState(false);

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto bg-white px-4 py-6 dark:bg-black">
      <h1 className="text-2xl font-bold text-black dark:text-white">
        코스 만들기
      </h1>

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

      <section className="flex flex-col gap-3">
        <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          일정 단계
        </label>

        {stages.length === 0 && (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            예: 문화 생활 → 맛집 → 카페. 아래 버튼으로 단계를 추가해보세요.
          </p>
        )}

        <Reorder.Group
          axis="y"
          values={stages}
          onReorder={onReorderStages}
          className="flex flex-col gap-3"
        >
          {stages.map((stage, index) => (
            <StageRow
              key={stage.id}
              stage={stage}
              index={index}
              total={stages.length}
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
        <TravelTimePicker
          value={maxTravelMinutes}
          onConfirm={(minutes) => {
            onSetMaxTravelMinutes(minutes);
            setTravelPickerOpen(false);
          }}
          onClose={() => setTravelPickerOpen(false)}
        />
      )}

      <button
        type="button"
        onClick={onMakeCourse}
        disabled={stages.length === 0}
        className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white disabled:opacity-30 dark:bg-white dark:text-black"
      >
        코스 만들기
      </button>
    </div>
  );
}

const TRAVEL_PICKER_ITEM_HEIGHT = 48;
const TRAVEL_OPTIONS = Array.from(
  { length: MAX_TRAVEL_MINUTES - MIN_TRAVEL_MINUTES + 1 },
  (_, i) => MIN_TRAVEL_MINUTES + i,
);

/** 위아래로 스크롤해서 가운데에 멈춘 값을 고르는 구간별 최대 이동시간 선택창. */
function TravelTimePicker({
  value,
  onConfirm,
  onClose,
}: {
  value: number;
  onConfirm: (minutes: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(value);

  useEffect(() => {
    // 열릴 때 현재 값이 가운데에 오도록 한 번만 맞춘다.
    listRef.current?.scrollTo({ top: (value - MIN_TRAVEL_MINUTES) * TRAVEL_PICKER_ITEM_HEIGHT });
  }, [value]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    const index = Math.round(el.scrollTop / TRAVEL_PICKER_ITEM_HEIGHT);
    const clamped = Math.min(Math.max(index, 0), TRAVEL_OPTIONS.length - 1);
    setSelected(TRAVEL_OPTIONS[clamped]);
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 pb-16">
      <div className="mx-2 flex w-full max-w-md flex-col gap-4 rounded-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">구간별 최대 이동시간</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700 dark:text-white"
          >
            ✕
          </button>
        </div>

        <div className="relative" style={{ height: TRAVEL_PICKER_ITEM_HEIGHT * 3 }}>
          <div
            className="pointer-events-none absolute inset-x-0 rounded-lg bg-zinc-100 dark:bg-zinc-800"
            style={{ top: TRAVEL_PICKER_ITEM_HEIGHT, height: TRAVEL_PICKER_ITEM_HEIGHT }}
          />
          <div
            ref={listRef}
            onScroll={onScroll}
            data-testid="travel-picker"
            className="relative h-full snap-y snap-mandatory overflow-y-scroll"
            style={{ scrollbarWidth: "none" }}
          >
            <div style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }} />
            {TRAVEL_OPTIONS.map((m) => (
              <div
                key={m}
                onClick={() =>
                  listRef.current?.scrollTo({
                    top: (m - MIN_TRAVEL_MINUTES) * TRAVEL_PICKER_ITEM_HEIGHT,
                    behavior: "smooth",
                  })
                }
                className={`flex snap-center items-center justify-center text-xl ${
                  m === selected
                    ? "font-bold text-black dark:text-white"
                    : "text-zinc-400 dark:text-zinc-500"
                }`}
                style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }}
              >
                {m}분
              </div>
            ))}
            <div style={{ height: TRAVEL_PICKER_ITEM_HEIGHT }} />
          </div>
        </div>

        <button
          type="button"
          onClick={() => onConfirm(selected)}
          className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
        >
          확인
        </button>
      </div>
    </div>
  );
}

function StageRow({
  stage,
  index,
  total,
  onRemove,
  onRequestChangeDesignated,
}: {
  stage: Stage;
  index: number;
  total: number;
  onRemove: (id: string) => void;
  onRequestChangeDesignated: (stageId: string) => void;
}) {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={stage}
      dragListener={false}
      dragControls={dragControls}
      className="flex flex-col gap-2 rounded-xl border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-black"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="눌러서 순서 변경"
          onPointerDown={(e) => dragControls.start(e)}
          style={{ touchAction: "none" }}
          className="flex h-11 w-9 shrink-0 cursor-grab items-center justify-center text-xl text-zinc-400 active:cursor-grabbing dark:text-zinc-500"
        >
          ⠿
        </button>

        <div className="flex-1">
          {stage.kind === "recommend" ? (
            <span className="text-base font-medium text-black dark:text-white">
              {stage.category}
              {stage.subCategory ? ` · ${stage.subCategory}` : ""}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="w-fit rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                지정 · {positionLabel(index, total)}
              </span>
              <span className="text-base font-medium text-black dark:text-white">
                {stage.place.name}
              </span>
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="단계 삭제"
          onClick={() => onRemove(stage.id)}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg text-red-500 dark:border-zinc-700"
        >
          ✕
        </button>
      </div>

      {stage.kind === "designated" && (
        <>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {stage.place.address}
          </span>
          <button
            type="button"
            onClick={() => onRequestChangeDesignated(stage.id)}
            className="h-9 w-fit rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
          >
            변경
          </button>
        </>
      )}
    </Reorder.Item>
  );
}

function AddStageSheet({
  canAddMore,
  onClose,
  onAddRecommend,
  onStartDesignated,
}: {
  canAddMore: boolean;
  onClose: () => void;
  onAddRecommend: (
    category: PlaceCategory,
    subCategory: string | undefined,
  ) => void;
  onStartDesignated: () => void;
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
            {category ? `${category} 세부 카테고리` : "단계 추가"}
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
            <button
              type="button"
              onClick={onStartDesignated}
              className="flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl border border-zinc-300 dark:border-zinc-700"
            >
              <span className="text-base font-medium text-black dark:text-white">
                장소 직접 지정
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                꼭 갈 곳, 출발하는 역, 끝나는 곳을 넣으면 나머지는 그 주변에서
                추천해요
              </span>
            </button>
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
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [lat, setLat] = useState(initial?.lat ?? REGION_CENTER.lat);
  const [lng, setLng] = useState(initial?.lng ?? REGION_CENTER.lng);

  const outsideRegion = !isWithinRegionRange({ lat, lng });
  const canSubmit = name.trim().length > 0 && address.trim().length > 0;

  function submit(place: DesignatedPlace) {
    onSubmit(place);
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-900">
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

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          네이버 장소 검색 키 발급 전까지는 직접 입력으로 지정해요. 이름·주소와,
          대략의 위도·경도(종로 일대는 위도 37.57~37.58, 경도 126.975~126.992)를
          넣어주세요.
        </p>

        {recentPlaces.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              최근 지정 장소
            </span>
            <ul className="flex flex-col gap-2">
              {recentPlaces.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => submit(p)}
                    className="flex w-full flex-col items-start rounded-lg border border-zinc-300 p-2 text-left dark:border-zinc-700"
                  >
                    <span className="text-sm font-medium text-black dark:text-white">
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
        )}

        <div className="flex flex-col gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="이름 (예: 안국역)"
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="주소 (예: 서울 종로구 율곡로 口)"
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
          <div className="flex gap-2">
            <input
              type="number"
              step="0.0001"
              value={lat}
              onChange={(e) => setLat(Number(e.target.value))}
              placeholder="위도"
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
            />
            <input
              type="number"
              step="0.0001"
              value={lng}
              onChange={(e) => setLng(Number(e.target.value))}
              placeholder="경도"
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
            />
          </div>

          {outsideRegion && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              이 장소는 코스에 들어가지만, 주변 추천은 종로 일대에서만 돼요.
            </p>
          )}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              submit({
                id: initial?.id ?? generateId("designated"),
                name: name.trim(),
                address: address.trim(),
                lat,
                lng,
              })
            }
            className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white disabled:opacity-30 dark:bg-white dark:text-black"
          >
            이 장소로 지정
          </button>
        </div>
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

function ResultView({
  result,
  avatarPoint,
  onBack,
  onReplace,
  onRequestChangeDesignated,
  onDecideRoute,
}: {
  result: CourseResult;
  avatarPoint: { lat: number; lng: number };
  onBack: () => void;
  onReplace: (stageId: string, placeId: string) => void;
  onRequestChangeDesignated: (stageId: string) => void;
  onDecideRoute: () => void;
}) {
  const [openStageId, setOpenStageId] = useState<string | null>(null);
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
                  일정 날짜에 쉬는 {failedStage.closedExcludedCount}곳은 후보에서
                  제외됐어요. 날짜를 바꿔보는 것도 방법이에요.
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
            <p className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-400">
              총 이동시간 약 {Math.round(result.totalTravelMinutes)}분
            </p>

            <ul className="flex flex-col gap-3">
              {result.stages.map((stageResult, index) => (
                <li key={stageResult.stage.id} className="flex flex-col gap-3">
                  {index > 0 &&
                    stageResult.travelMinutesFromPrevious !== null && (
                      <p
                        className={`text-center text-sm ${
                          stageResult.kind === "designated" &&
                          stageResult.travelExceedsMax
                            ? "font-medium text-amber-600 dark:text-amber-400"
                            : "text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        도보 약{" "}
                        {Math.round(stageResult.travelMinutesFromPrevious)}분
                        {stageResult.kind === "designated" &&
                        stageResult.travelExceedsMax
                          ? " · 설정보다 길어요"
                          : ""}
                      </p>
                    )}

                  {stageResult.kind === "recommend" && stageResult.selected && (
                    <div className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-col gap-1">
                          <span className="w-fit rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            {stageResult.selected.category}
                            {stageResult.selected.subCategory
                              ? ` · ${stageResult.selected.subCategory}`
                              : ""}
                          </span>
                          <span className="text-lg font-semibold text-black dark:text-white">
                            {stageResult.selected.name}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setOpenStageId(stageResult.stage.id)}
                          className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          교체
                        </button>
                      </div>
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                        ★ {stageResult.selected.rating.toFixed(1)} · 리뷰{" "}
                        {stageResult.selected.reviewCount.toLocaleString()}개
                      </span>
                      <span className="text-sm text-zinc-500 dark:text-zinc-500">
                        {stageResult.selected.description}
                      </span>
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                        🕒 {formatOpeningHours(stageResult.selected)}
                      </span>
                    </div>
                  )}

                  {stageResult.kind === "designated" && (
                    <div className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-col gap-1">
                          <span className="w-fit rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            지정 · {positionLabel(index, result.stages.length)}
                          </span>
                          <span className="text-lg font-semibold text-black dark:text-white">
                            {stageResult.selected.name}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onRequestChangeDesignated(stageResult.stage.id)
                          }
                          className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          변경
                        </button>
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
                      <span className="text-sm text-zinc-500 dark:text-zinc-500">
                        🕒 운영 시간 정보 없음
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {result.success && (
        <div className="mx-auto w-full max-w-md shrink-0 p-4 pt-0">
          <button
            type="button"
            onClick={onDecideRoute}
            className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white dark:bg-white dark:text-black"
          >
            동선 결정!
          </button>
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
  const [loggedIn, setLoggedIn] = useState(false);

  if (!loggedIn) {
    return <LoginScreen onLogin={() => setLoggedIn(true)} />;
  }

  return <CourseBuilder />;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
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
        <button
          type="button"
          onClick={onLogin}
          className="h-14 w-full rounded-xl bg-[#FEE500] text-base font-semibold text-black"
        >
          카카오로 로그인
        </button>
        <button
          type="button"
          onClick={onLogin}
          className="h-14 w-full rounded-xl border border-zinc-300 text-base font-semibold text-black dark:border-zinc-700 dark:text-white"
        >
          로그인 없이 둘러보기
        </button>
      </div>

      <p className="max-w-xs text-center text-xs text-zinc-400 dark:text-zinc-500">
        로그인 기능은 아직 준비 중이에요. 버튼을 누르면 체험용으로 바로
        시작돼요.
      </p>
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
        <span className="text-5xl">🧘</span>
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
          aria-label="아바타"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-sm shadow-sm dark:bg-black/40"
        >
          🧑
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

  useEffect(() => {
    // localStorage는 브라우저에서만 읽을 수 있어 마운트 후에 한 번 불러온다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(loadOrCreatePersonalCode());
  }, []);

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
      </div>
    </div>
  );
}
