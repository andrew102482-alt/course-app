import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "course_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type SessionUser = { id: string; name: string };

// 서명 키는 서버에만 있는 네이버 Client Secret에서 만든다(브라우저로 나가지 않음).
function signingKey(): string {
  return `course-app-session:${process.env.NAVER_CLIENT_SECRET ?? ""}`;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/** 로그인한 사용자 정보를 위변조할 수 없게 서명한 문자열(쿠키 값)로 만든다. */
export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...user,
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** 쿠키 값이 올바르고 만료되지 않았으면 사용자 정보를, 아니면 null을 돌려준다. */
export function readSessionToken(
  token: string | undefined,
): SessionUser | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      typeof data.id !== "string" ||
      typeof data.name !== "string" ||
      typeof data.exp !== "number" ||
      data.exp < Date.now() / 1000
    ) {
      return null;
    }
    return { id: data.id, name: data.name };
  } catch {
    return null;
  }
}
