"use client";

import { useEffect, useMemo, useState } from "react";
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

const LAST_INPUT_STORAGE_KEY = "course-app:last-input";
const RECENT_DESIGNATED_STORAGE_KEY = "course-app:recent-designated";

let nextId = 1;
function generateId(prefix: string) {
  return `${prefix}-${nextId++}`;
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

export default function Home() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(DEFAULT_TRAVEL_MINUTES);
  const [hydrated, setHydrated] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [overrides, setOverrides] = useState<StageOverrides>({});
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [designatedEditTarget, setDesignatedEditTarget] = useState<string | "new" | null>(null);
  const [recentDesignated, setRecentDesignated] = useState<DesignatedPlace[]>([]);

  useEffect(() => {
    // localStorage는 서버에 없는 브라우저 전용 저장소라 마운트 후에만 읽을 수 있다.
    // 초기 렌더와 다른 값이 돼도 안전하므로(사용자 입력을 기억해두는 용도일 뿐)
    // 여기서 한 번만 읽어 상태에 반영한다.
    const last = loadLastInput();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStages(last ? last.stages : []);
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

  function moveStage(id: string, direction: -1 | 1) {
    setStages((prev) => {
      const index = prev.findIndex((s) => s.id === id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
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

  return (
    <>
      {showResult ? (
        <ResultView
          result={result}
          onBack={() => setShowResult(false)}
          onReplace={replaceRecommendStage}
          onRequestChangeDesignated={(stageId) => setDesignatedEditTarget(stageId)}
        />
      ) : (
        <InputView
          stages={stages}
          maxTravelMinutes={maxTravelMinutes}
          onSetMaxTravelMinutes={setMaxTravelMinutes}
          onOpenAddSheet={() => setAddSheetOpen(true)}
          onRemoveStage={removeStage}
          onMoveStage={moveStage}
          onRequestChangeDesignated={(stageId) => setDesignatedEditTarget(stageId)}
          onMakeCourse={makeCourse}
        />
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
  onMoveStage,
  onRequestChangeDesignated,
  onMakeCourse,
}: {
  stages: Stage[];
  maxTravelMinutes: number;
  onSetMaxTravelMinutes: (minutes: number) => void;
  onOpenAddSheet: () => void;
  onRemoveStage: (id: string) => void;
  onMoveStage: (id: string, direction: -1 | 1) => void;
  onRequestChangeDesignated: (stageId: string) => void;
  onMakeCourse: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 bg-white px-4 py-6 dark:bg-black">
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

        <ul className="flex flex-col gap-3">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              className="flex flex-col gap-2 rounded-xl border border-zinc-300 p-3 dark:border-zinc-700"
            >
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  {stage.kind === "recommend" ? (
                    <span className="text-base font-medium text-black dark:text-white">
                      {stage.category}
                      {stage.subCategory ? ` · ${stage.subCategory}` : ""}
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="w-fit rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        지정 · {positionLabel(index, stages.length)}
                      </span>
                      <span className="text-base font-medium text-black dark:text-white">
                        {stage.place.name}
                      </span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  aria-label="위로 이동"
                  onClick={() => onMoveStage(stage.id, -1)}
                  disabled={index === 0}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg disabled:opacity-30 dark:border-zinc-700 dark:text-white"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="아래로 이동"
                  onClick={() => onMoveStage(stage.id, 1)}
                  disabled={index === stages.length - 1}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg disabled:opacity-30 dark:border-zinc-700 dark:text-white"
                >
                  ▼
                </button>
                <button
                  type="button"
                  aria-label="단계 삭제"
                  onClick={() => onRemoveStage(stage.id)}
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
            </li>
          ))}
        </ul>

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

function ResultView({
  result,
  onBack,
  onReplace,
  onRequestChangeDesignated,
}: {
  result: CourseResult;
  onBack: () => void;
  onReplace: (stageId: string, placeId: string) => void;
  onRequestChangeDesignated: (stageId: string) => void;
}) {
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const openStageIndex = result.stages.findIndex((s) => s.stage.id === openStageId);
  const openStageResult = openStageIndex === -1 ? null : result.stages[openStageIndex];
  const nextSelected =
    openStageIndex === -1 ? null : (result.stages[openStageIndex + 1]?.selected ?? null);

  const failedIndex = result.stages.findIndex(
    (s): s is RecommendStageResult => s.kind === "recommend" && s.selected === null,
  );
  const failedStage = failedIndex === -1 ? null : (result.stages[failedIndex] as RecommendStageResult);
  const blockingDesignated =
    failedStage?.blockedByDesignated && result.stages[failedIndex + 1]?.kind === "designated"
      ? result.stages[failedIndex + 1]
      : null;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 bg-white px-4 py-6 dark:bg-black">
      <div className="flex items-center gap-3">
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
      ) : (
        <>
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
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
        </>
      )}

      {openStageResult && openStageResult.kind === "recommend" && (
        <ReplaceSheet
          stageResult={openStageResult}
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

function ReplaceSheet({
  stageResult,
  nextSelected,
  onClose,
  onSelect,
}: {
  stageResult: RecommendStageResult;
  nextSelected: Place | DesignatedPlace | null;
  onClose: () => void;
  onSelect: (placeId: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
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

        <ul className="flex flex-col gap-2">
          {stageResult.candidates.map((candidate) => {
            const isSelected = candidate.place.id === stageResult.selected?.id;
            const nextMinutes = nextSelected
              ? walkingMinutesBetween(candidate.place, nextSelected)
              : null;

            return (
              <li key={candidate.place.id}>
                <button
                  type="button"
                  disabled={!candidate.withinMaxTravel}
                  onClick={() => onSelect(candidate.place.id)}
                  className={`flex w-full flex-col gap-1 rounded-xl border p-3 text-left ${
                    isSelected
                      ? "border-black dark:border-white"
                      : "border-zinc-300 dark:border-zinc-700"
                  } ${candidate.withinMaxTravel ? "" : "opacity-40"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-black dark:text-white">
                      {candidate.place.name}
                      {isSelected ? " (현재 선택)" : ""}
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
  );
}
