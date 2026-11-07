export const AVATAR_STORAGE_KEY = "course-app:avatar";
export const NICKNAME_STORAGE_KEY = "course-app:nickname";
export const MAX_NICKNAME_LENGTH = 12;

export const AVATAR_CHARACTERS = [
  "🧑",
  "👩",
  "👨",
  "🧒",
  "🧓",
  "🐻",
  "🐱",
  "🐶",
  "🦊",
  "🐰",
] as const;

/** 빈 문자열은 "없음". */
export const AVATAR_ACCESSORIES = [
  "",
  "🎩",
  "👑",
  "🧢",
  "🕶️",
  "🎀",
  "👓",
] as const;

export type Avatar = { character: string; accessory: string };

export const DEFAULT_AVATAR: Avatar = { character: "🧑", accessory: "" };

export function loadAvatar(): Avatar {
  try {
    const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      (AVATAR_CHARACTERS as readonly string[]).includes(parsed.character) &&
      (AVATAR_ACCESSORIES as readonly string[]).includes(parsed.accessory)
    ) {
      return { character: parsed.character, accessory: parsed.accessory };
    }
  } catch {
    // 못 읽으면 기본 아바타를 쓴다.
  }
  return DEFAULT_AVATAR;
}

export function saveAvatar(avatar: Avatar): void {
  try {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatar));
  } catch {
    // 저장에 실패해도 이번 화면에서는 고른 모습이 유지된다.
  }
}

export function loadNickname(): string {
  try {
    return window.localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveNickname(nickname: string): void {
  try {
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  } catch {
    // 저장에 실패해도 이번 화면에서는 입력한 닉네임이 유지된다.
  }
}
