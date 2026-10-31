"use client";

import { useMemo, useState } from "react";
import { places, type Place, type PlaceCategory } from "@/data/places";
import {
  buildCourse,
  walkingMinutesBetween,
  type CourseResult,
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

let nextStageId = 1;
function createStage(): Stage {
  return { id: `stage-${nextStageId++}`, category: "전시" };
}

export default function Home() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(
    DEFAULT_TRAVEL_MINUTES,
  );
  const [showResult, setShowResult] = useState(false);
  const [overrides, setOverrides] = useState<StageOverrides>({});
  const result = useMemo(
    () => buildCourse(stages, places, maxTravelMinutes, overrides),
    [stages, maxTravelMinutes, overrides],
  );

  function addStage() {
    setStages((prev) => [...prev, createStage()]);
  }

  function removeStage(id: string) {
    setStages((prev) => prev.filter((stage) => stage.id !== id));
  }

  function changeCategory(id: string, category: PlaceCategory) {
    setStages((prev) =>
      prev.map((stage) =>
        stage.id === id ? { id, category, subCategory: undefined } : stage,
      ),
    );
  }

  function changeSubCategory(id: string, subCategory: string) {
    setStages((prev) =>
      prev.map((stage) =>
        stage.id === id
          ? {
              ...stage,
              subCategory: subCategory === "상관없음" ? undefined : subCategory,
            }
          : stage,
      ),
    );
  }

  function moveStage(id: string, direction: -1 | 1) {
    setStages((prev) => {
      const index = prev.findIndex((stage) => stage.id === id);
      const targetIndex = index + direction;
      if (index === -1 || targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  function makeCourse() {
    setOverrides({});
    setShowResult(true);
  }

  function replaceStage(stageId: string, placeId: string) {
    setOverrides((prev) => ({ ...prev, [stageId]: placeId }));
  }

  if (showResult) {
    return (
      <ResultView
        result={result}
        onBack={() => setShowResult(false)}
        onReplace={replaceStage}
      />
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 bg-white px-4 py-6 dark:bg-black">
      <h1 className="text-2xl font-bold text-black dark:text-white">
        코스 만들기
      </h1>

      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          지역
        </label>
        <div className="flex h-12 w-full items-center rounded-xl border border-zinc-300 bg-zinc-50 px-4 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white">
          종로
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            일정 단계
          </label>
        </div>

        {stages.length === 0 && (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            아래 버튼으로 단계를 추가해보세요.
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              className="flex flex-col gap-3 rounded-xl border border-zinc-300 p-3 dark:border-zinc-700"
            >
              <div className="flex items-center gap-2">
                <select
                  value={stage.category}
                  onChange={(e) =>
                    changeCategory(stage.id, e.target.value as PlaceCategory)
                  }
                  className="h-11 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  aria-label="위로 이동"
                  onClick={() => moveStage(stage.id, -1)}
                  disabled={index === 0}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg disabled:opacity-30 dark:border-zinc-700 dark:text-white"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="아래로 이동"
                  onClick={() => moveStage(stage.id, 1)}
                  disabled={index === stages.length - 1}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg disabled:opacity-30 dark:border-zinc-700 dark:text-white"
                >
                  ▼
                </button>
                <button
                  type="button"
                  aria-label="단계 삭제"
                  onClick={() => removeStage(stage.id)}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 text-lg text-red-500 dark:border-zinc-700"
                >
                  ✕
                </button>
              </div>

              {SUB_CATEGORIES[stage.category].length > 0 && (
                <select
                  value={stage.subCategory ?? "상관없음"}
                  onChange={(e) =>
                    changeSubCategory(stage.id, e.target.value)
                  }
                  className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                >
                  <option value="상관없음">상관없음</option>
                  {SUB_CATEGORIES[stage.category].map((sub) => (
                    <option key={sub} value={sub}>
                      {sub}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={addStage}
          className="h-12 w-full rounded-xl border border-dashed border-zinc-400 text-base font-medium text-zinc-600 dark:border-zinc-600 dark:text-zinc-300"
        >
          + 단계 추가
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <label
          htmlFor="max-travel"
          className="flex items-center justify-between text-sm font-medium text-zinc-600 dark:text-zinc-400"
        >
          <span>최대 이동시간</span>
          <span className="text-black dark:text-white">
            {maxTravelMinutes}분
          </span>
        </label>
        <input
          id="max-travel"
          type="range"
          min={MIN_TRAVEL_MINUTES}
          max={MAX_TRAVEL_MINUTES}
          value={maxTravelMinutes}
          onChange={(e) => setMaxTravelMinutes(Number(e.target.value))}
          className="h-11 w-full"
        />
        <div className="flex justify-between text-xs text-zinc-400 dark:text-zinc-500">
          <span>{MIN_TRAVEL_MINUTES}분</span>
          <span>{MAX_TRAVEL_MINUTES}분</span>
        </div>
      </section>

      <button
        type="button"
        onClick={makeCourse}
        disabled={stages.length === 0}
        className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white disabled:opacity-30 dark:bg-white dark:text-black"
      >
        코스 만들기
      </button>
    </div>
  );
}

function ResultView({
  result,
  onBack,
  onReplace,
}: {
  result: CourseResult;
  onBack: () => void;
  onReplace: (stageId: string, placeId: string) => void;
}) {
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const openStageIndex = result.stages.findIndex(
    (s) => s.stage.id === openStageId,
  );
  const openStageResult =
    openStageIndex === -1 ? null : result.stages[openStageIndex];
  const nextSelected =
    openStageIndex === -1
      ? null
      : (result.stages[openStageIndex + 1]?.selected ?? null);

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
        <h1 className="text-2xl font-bold text-black dark:text-white">
          추천 결과
        </h1>
      </div>

      {!result.success ? (
        <p className="rounded-xl border border-zinc-300 p-4 text-base text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          조건에 맞는 곳을 찾지 못했어요. 최대 이동시간을 늘리거나 세부
          카테고리를 해제해보세요.
        </p>
      ) : (
        <>
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            총 이동시간 약 {Math.round(result.totalTravelMinutes)}분
          </p>

          <ul className="flex flex-col gap-3">
            {result.stages.map((stageResult, index) => (
              <li key={stageResult.stage.id} className="flex flex-col gap-3">
                {index > 0 && stageResult.travelMinutesFromPrevious !== null && (
                  <p className="text-center text-sm text-zinc-400 dark:text-zinc-500">
                    도보 약 {Math.round(stageResult.travelMinutesFromPrevious)}분
                  </p>
                )}
                {stageResult.selected && (
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
              </li>
            ))}
          </ul>
        </>
      )}

      {openStageResult && (
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
  stageResult: StageResult;
  nextSelected: Place | null;
  onClose: () => void;
  onSelect: (placeId: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
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
  );
}
