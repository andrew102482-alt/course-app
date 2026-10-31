"use client";

import { useState } from "react";

type StageCategory = "전시" | "맛집" | "카페";

type Stage = {
  id: string;
  category: StageCategory;
  subCategory?: string;
};

const CATEGORIES: StageCategory[] = ["전시", "맛집", "카페"];

const SUB_CATEGORIES: Record<StageCategory, string[]> = {
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

  function addStage() {
    setStages((prev) => [...prev, createStage()]);
  }

  function removeStage(id: string) {
    setStages((prev) => prev.filter((stage) => stage.id !== id));
  }

  function changeCategory(id: string, category: StageCategory) {
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
                    changeCategory(stage.id, e.target.value as StageCategory)
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
        onClick={() => {}}
        className="h-14 w-full rounded-xl bg-black text-lg font-semibold text-white dark:bg-white dark:text-black"
      >
        코스 만들기
      </button>
    </div>
  );
}
