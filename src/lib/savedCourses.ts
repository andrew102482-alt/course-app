import type { CourseResult } from "./course.ts";

export const SAVED_COURSES_STORAGE_KEY = "course-app:saved-courses";
export const MAX_SAVED_COURSES = 30;

/** 저장한 코스의 한 장소. 다시 열 때 검색하지 않아도 되게 이름·좌표를 그대로 담는다. */
export type SavedStop = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** 추천 장소면 카테고리(지정 장소는 없음). */
  category?: string;
};

export type SavedCourse = {
  id: string;
  name: string;
  savedAt: string;
  totalTravelMinutes: number;
  stops: SavedStop[];
};

/** 코스 결과를 저장용 모양으로 바꾼다. 장소가 정해지지 않은 단계가 있으면 null. */
export function toSavedCourse(
  result: CourseResult,
  now: Date = new Date(),
): SavedCourse | null {
  const stops: SavedStop[] = [];
  for (const stage of result.stages) {
    if (stage.selected === null) return null;
    if (stage.kind === "designated") {
      stops.push({
        name: stage.selected.name,
        address: stage.selected.address,
        lat: stage.selected.lat,
        lng: stage.selected.lng,
      });
    } else {
      stops.push({
        name: stage.selected.name,
        address: stage.selected.region,
        lat: stage.selected.lat,
        lng: stage.selected.lng,
        category: stage.selected.category,
      });
    }
  }
  if (stops.length === 0) return null;
  return {
    id: `course-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${now.getMonth() + 1}월 ${now.getDate()}일 코스`,
    savedAt: now.toISOString(),
    totalTravelMinutes: result.totalTravelMinutes,
    stops,
  };
}

export function loadSavedCourses(): SavedCourse[] {
  try {
    const raw = window.localStorage.getItem(SAVED_COURSES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedCourse[]) : [];
  } catch {
    return [];
  }
}

/** 맨 앞에 추가하고 최대 개수를 넘으면 오래된 것부터 버린다. 저장에 실패하면 false. */
export function saveCourse(course: SavedCourse): boolean {
  try {
    const next = [course, ...loadSavedCourses()].slice(0, MAX_SAVED_COURSES);
    window.localStorage.setItem(
      SAVED_COURSES_STORAGE_KEY,
      JSON.stringify(next),
    );
    return true;
  } catch {
    return false;
  }
}
