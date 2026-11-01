"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { places, type Place, type PlaceCategory } from "@/data/places";
import {
  REGION_CENTER,
  buildCourse,
  isWithinRegionRange,
  kakaoMapLinkFor,
  walkingMinutesBetween,
  type CourseResult,
  type DesignatedPlace,
  type RecommendStageResult,
  type Stage,
  type StageOverrides,
  type StageResult,
} from "@/lib/course";

const CATEGORIES: PlaceCategory[] = ["전시", "맛집", "카페"];

const SUB_CATEGORIES: Record<PlaceCategory, string[]> = {
  전시: [],
  맛집: ["한식", "일식", "양식", "중식"],
  카페: ["디저트", "브런치", "뷰"],
};

const MIN_TRAVEL_MINUTES = 5;
const MAX_TRAVEL_MINUTES = 30;
const DEFAULT_TRAVEL_MINUTES = 15;
const MAX_STAGES = 8;
const MAX_RECENT_DESIGNATED = 10;
/** 아바타 영역이 차지하는 화면 비율(나머지는 코스 만들기 패널). 드래그로 바꿀 수 없는 고정값. */
const AVATAR_FIXED_SHARE = 0.4;

const LAST_INPUT_STORAGE_KEY = "course-app:last-input";
const RECENT_DESIGNATED_STORAGE_KEY = "course-app:recent-designated";

let nextId = 1;
function generateId(prefix: string) {
  // localStorage에 저장된 이전 세션의 id와 겹치지 않도록, 페이지가 새로 열릴 때마다
  // 초기화되는 카운터 대신 브라우저가 제공하는 무작위 값을 사용한다.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${nextId++}`;
}

function dedupeStageIds(stages: Stage[]): Stage[] {
  // 과거 버전의 id 생성 방식 때문에 localStorage에 이미 중복된 id로 저장된
  // 일정이 있을 수 있어, 불러올 때 중복분만 새 id로 바꿔준다.
  const seen = new Set<string>();
  return stages.map((stage) => {
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
    if (!Array.isArray(parsed.stages) || typeof parsed.maxTravelMinutes !== "number") {
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
    window.localStorage.setItem(RECENT_DESIGNATED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 무시
  }
}

function positionLabel(index: number, total: number): "출발" | "경유" | "도착" {
  if (index === 0) return "출발";
  if (index === total - 1) return "도착";
  return "경유";
}

function CourseBuilder() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(DEFAULT_TRAVEL_MINUTES);
  const [hydrated, setHydrated] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [overrides, setOverrides] = useState<StageOverrides>({});
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [designatedEditTarget, setDesignatedEditTarget] = useState<string | "new" | null>(null);
  const [recentDesignated, setRecentDesignated] = useState<DesignatedPlace[]>([]);

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [navigating, setNavigating] = useState(false);

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
        setLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
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
        setLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
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
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLastInput(stages, maxTravelMinutes);
  }, [stages, maxTravelMinutes, hydrated]);

  const result = useMemo(
    () => buildCourse(stages, places, maxTravelMinutes, overrides),
    [stages, maxTravelMinutes, overrides],
  );

  function addRecommendStage(category: PlaceCategory, subCategory: string | undefined) {
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
          s.id === designatedEditTarget && s.kind === "designated" ? { ...s, place } : s,
        );
      }
      return [...prev, { id: generateId("stage"), kind: "designated" as const, place }];
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
      ? stages.find((s) => s.id === designatedEditTarget && s.kind === "designated")
      : null;

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
          onRequestChangeDesignated={(stageId) => setDesignatedEditTarget(stageId)}
          onDecideRoute={() => setNavigating(true)}
        />
      ) : (
        <div className="flex h-screen w-full flex-col bg-white dark:bg-black">
          <div style={{ flexGrow: AVATAR_FIXED_SHARE, flexBasis: 0 }} className="min-h-0">
            <AvatarScene status={locationStatus} />
          </div>

          <div
            style={{ flexGrow: 1 - AVATAR_FIXED_SHARE, flexBasis: 0 }}
            className="min-h-0 overflow-hidden"
          >
            <InputView
              stages={stages}
              maxTravelMinutes={maxTravelMinutes}
              onSetMaxTravelMinutes={setMaxTravelMinutes}
              onOpenAddSheet={() => setAddSheetOpen(true)}
              onRemoveStage={removeStage}
              onReorderStages={setStages}
              onRequestChangeDesignated={(stageId) => setDesignatedEditTarget(stageId)}
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
          initial={editingPlace && editingPlace.kind === "designated" ? editingPlace.place : null}
          recentPlaces={recentDesignated}
          onClose={() => setDesignatedEditTarget(null)}
          onSubmit={upsertDesignatedStage}
        />
      )}
    </>
  );
}

function InputView({
  stages,
  maxTravelMinutes,
  onSetMaxTravelMinutes,
  onOpenAddSheet,
  onRemoveStage,
  onReorderStages,
  onRequestChangeDesignated,
  onMakeCourse,
}: {
  stages: Stage[];
  maxTravelMinutes: number;
  onSetMaxTravelMinutes: (minutes: number) => void;
  onOpenAddSheet: () => void;
  onRemoveStage: (id: string) => void;
  onReorderStages: (stages: Stage[]) => void;
  onRequestChangeDesignated: (stageId: string) => void;
  onMakeCourse: () => void;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto bg-white px-4 py-6 dark:bg-black">
      <h1 className="text-2xl font-bold text-black dark:text-white">코스 만들기</h1>

      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">지역</label>
        <div className="flex h-12 w-full items-center rounded-xl border border-zinc-300 bg-zinc-50 px-4 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white">
          종로
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">일정 단계</label>

        {stages.length === 0 && (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            예: 전시 → 맛집 → 카페. 아래 버튼으로 단계를 추가해보세요.
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

      <section className="flex flex-col gap-2">
        <label
          htmlFor="max-travel"
          className="flex items-center justify-between text-sm font-medium text-zinc-600 dark:text-zinc-400"
        >
          <span>최대 이동시간</span>
          <span className="text-black dark:text-white">{maxTravelMinutes}분</span>
        </label>
        <input
          id="max-travel"
          type="range"
          min={MIN_TRAVEL_MINUTES}
          max={MAX_TRAVEL_MINUTES}
          value={maxTravelMinutes}
          onChange={(e) => onSetMaxTravelMinutes(Number(e.target.value))}
          className="h-11 w-full"
        />
        <div className="flex justify-between text-xs text-zinc-400 dark:text-zinc-500">
          <span>{MIN_TRAVEL_MINUTES}분</span>
          <span>{MAX_TRAVEL_MINUTES}분</span>
        </div>
      </section>

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
          <span className="text-sm text-zinc-500 dark:text-zinc-400">{stage.place.address}</span>
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
  onAddRecommend: (category: PlaceCategory, subCategory: string | undefined) => void;
  onStartDesignated: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "recommend">("choose");
  const [category, setCategory] = useState<PlaceCategory>("전시");
  const [subCategory, setSubCategory] = useState("상관없음");

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-black dark:text-white">단계 추가</h2>
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

        {canAddMore && mode === "choose" && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setMode("recommend")}
              className="flex h-14 w-full items-center justify-center rounded-xl border border-zinc-300 text-base font-medium text-black dark:border-zinc-700 dark:text-white"
            >
              추천받기
            </button>
            <button
              type="button"
              onClick={onStartDesignated}
              className="flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl border border-zinc-300 dark:border-zinc-700"
            >
              <span className="text-base font-medium text-black dark:text-white">
                장소 직접 지정
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                꼭 갈 곳, 출발하는 역, 끝나는 곳을 넣으면 나머지는 그 주변에서 추천해요
              </span>
            </button>
          </div>
        )}

        {canAddMore && mode === "recommend" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                카테고리
              </span>
              <div className="flex gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setCategory(c);
                      setSubCategory("상관없음");
                    }}
                    className={`h-11 flex-1 rounded-lg border text-base ${
                      category === c
                        ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                        : "border-zinc-300 text-black dark:border-zinc-700 dark:text-white"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {SUB_CATEGORIES[category].length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  세부 카테고리
                </span>
                <select
                  value={subCategory}
                  onChange={(e) => setSubCategory(e.target.value)}
                  className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                >
                  <option value="상관없음">상관없음</option>
                  {SUB_CATEGORIES[category].map((sub) => (
                    <option key={sub} value={sub}>
                      {sub}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                onAddRecommend(
                  category,
                  subCategory === "상관없음" ? undefined : subCategory,
                )
              }
              className="h-12 w-full rounded-xl bg-black text-base font-semibold text-white dark:bg-white dark:text-black"
            >
              추가
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
          카카오 장소 검색 키 발급 전까지는 직접 입력으로 지정해요. 이름·주소와,
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
  const dragRef = useRef<{ startY: number; startRatio: number; height: number } | null>(null);

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
    setRatio(Math.min(MAX_LIST_RATIO, Math.max(MIN_LIST_RATIO, drag.startRatio + deltaRatio)));
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
  const openStageIndex = result.stages.findIndex((s) => s.stage.id === openStageId);
  const openStageResult = openStageIndex === -1 ? null : result.stages[openStageIndex];
  const nextSelected =
    openStageIndex === -1 ? null : (result.stages[openStageIndex + 1]?.selected ?? null);
  const decidedStages =
    openStageIndex === -1
      ? []
      : result.stages.slice(0, openStageIndex).filter((s) => s.selected !== null);

  const failedIndex = result.stages.findIndex(
    (s): s is RecommendStageResult => s.kind === "recommend" && s.selected === null,
  );
  const failedStage = failedIndex === -1 ? null : (result.stages[failedIndex] as RecommendStageResult);
  const blockingDesignated =
    failedStage?.blockedByDesignated && result.stages[failedIndex + 1]?.kind === "designated"
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
        <h1 className="text-2xl font-bold text-black dark:text-white">추천 결과</h1>
      </div>

      {!result.success ? (
        <div className="mx-auto w-full max-w-md px-4 pb-6">
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700">
            <p className="text-base text-zinc-600 dark:text-zinc-300">
              {failedIndex + 1}번째 단계에서 조건에 맞는 곳을 찾지 못했어요.
            </p>
            {blockingDesignated && blockingDesignated.kind === "designated" ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                &apos;{blockingDesignated.stage.place.name}&apos; 지정 장소 근처라서 그래요.
                최대 이동시간을 늘리거나 지정 장소를 바꿔보세요.
              </p>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                최대 이동시간을 늘리거나 세부 카테고리를 해제해보세요.
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
                          onClick={() => onRequestChangeDesignated(stageResult.stage.id)}
                          className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          변경
                        </button>
                      </div>
                      <span className="text-sm text-zinc-500 dark:text-zinc-500">
                        {stageResult.selected.address}
                      </span>
                      <a
                        href={kakaoMapLinkFor(stageResult.selected)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-blue-600 dark:text-blue-400"
                      >
                        카카오맵에서 보기
                      </a>
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

function projectToMap(point: MapPoint, bounds: ReturnType<typeof computeMapBounds>) {
  const drawable = MAP_VIEW_SIZE - MAP_MARGIN * 2;
  const x = MAP_MARGIN + ((point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * drawable;
  const y =
    MAP_MARGIN + ((bounds.maxLat - point.lat) / (bounds.maxLat - bounds.minLat)) * drawable;
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

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    mid: { x: number; y: number };
  } | null>(null);
  const panRef = useRef<{ x: number; y: number; translate: { x: number; y: number } } | null>(
    null,
  );

  function zoomAt(point: { x: number; y: number }, s0: number, t0: typeof translate, nextScaleRaw: number) {
    const s1 = clampZoomScale(nextScaleRaw);
    setScale(s1);
    setTranslate({
      x: point.x - ((point.x - t0.x) * s1) / s0,
      y: point.y - ((point.y - t0.y) * s1) / s0,
    });
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(point, scale, translate, scale * factor);
  }

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
      zoomAt(pinch.mid, pinch.scale, translate, pinch.scale * (distance / pinch.distance));
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

  return {
    scale,
    translate,
    isZoomed: scale > 1.001,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp },
    reset,
  };
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
  const [previewId, setPreviewId] = useState<string | null>(stageResult.selected?.id ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const split = useResizableSplit(DEFAULT_LIST_RATIO, bodyRef);

  const previewCandidate = stageResult.candidates.find((c) => c.place.id === previewId);

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-white dark:bg-black">
      <div className="flex shrink-0 items-center justify-between p-4">
        <h2 className="text-lg font-bold text-black dark:text-white">다른 장소로 교체</h2>
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
                      {candidate.travelMinutesFromPrevious !== null && nextMinutes !== null && " · "}
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
  const zoomPan = useZoomPan();

  const decidedPoints: MapPoint[] = decidedStages
    .filter((s) => s.selected !== null)
    .map((s) => ({ lat: s.selected!.lat, lng: s.selected!.lng, name: s.selected!.name }));

  const allPoints: MapPoint[] = [
    ...decidedPoints,
    ...candidates.map((c) => ({ lat: c.place.lat, lng: c.place.lng, name: c.place.name })),
    ...(nextSelected
      ? [{ lat: nextSelected.lat, lng: nextSelected.lng, name: nextSelected.name }]
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
  const previewPoint = candidates.find((c) => c.place.id === previewPlaceId) ?? null;
  const previewProjected = previewPoint ? projectToMap(previewPoint.place, bounds) : null;
  const nextProjected = nextSelected ? projectToMap(nextSelected, bounds) : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
      <svg
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
              <circle cx={p.x} cy={p.y} r={10} className="fill-zinc-500 dark:fill-zinc-400" />
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
      </svg>

      {zoomPan.isZoomed && <ZoomResetButton onClick={zoomPan.reset} />}

      <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-400 dark:text-zinc-500">
        지도 임시 표시 · 카카오맵 연동 전
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
  const zoomPan = useZoomPan();

  const points: MapPoint[] = stages
    .filter((s) => s.selected !== null)
    .map((s) => ({ lat: s.selected!.lat, lng: s.selected!.lng, name: s.selected!.name }));

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
  const bounds = computeMapBounds(avatarMapPoint ? [...points, avatarMapPoint] : points);
  const projected = points.map((p) => projectToMap(p, bounds));
  const avatarProjected = avatarMapPoint ? projectToMap(avatarMapPoint, bounds) : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
      <svg
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
            <text x={avatarProjected.x} y={avatarProjected.y + 7} textAnchor="middle" fontSize={20}>
              🧍
            </text>
          </g>
        )}
      </svg>

      {zoomPan.isZoomed && <ZoomResetButton onClick={zoomPan.reset} />}

      <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-400 dark:text-zinc-500">
        지도 임시 표시 · 카카오맵 연동 전
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
        <h1 className="text-3xl font-bold text-black dark:text-white">코스 추천</h1>
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
        로그인 기능은 아직 준비 중이에요. 버튼을 누르면 체험용으로 바로 시작돼요.
      </p>
    </div>
  );
}

/** 아직 지도 없이, 여행을 기다리며 앉아있는 내 아바타를 보여주는 임시 장면. */
function AvatarScene({ status }: { status: LocationStatus }) {
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
      <span className="absolute left-[12%] top-[14%] text-3xl opacity-80">☁️</span>
      <span className="absolute left-[60%] top-[8%] text-2xl opacity-70">☁️</span>

      <span className="absolute bottom-[32%] left-[4%] text-6xl drop-shadow">🌴</span>

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
          aria-label="설정"
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
        className="absolute bottom-2 right-2 flex h-8 items-center gap-1 rounded-full bg-white/80 px-3 text-xs font-medium text-zinc-700 shadow-sm dark:bg-black/40 dark:text-zinc-200"
      >
        👥 그룹
      </button>
    </div>
  );
}
