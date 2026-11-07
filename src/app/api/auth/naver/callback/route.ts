import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
} from "@/lib/session";

const STATE_COOKIE = "naver_state";

/** 네이버에서 돌아오는 곳: 받은 코드로 로그인 정보를 확인하고 이 앱의 로그인 상태를 만든다. */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const fail = () => {
    const res = NextResponse.redirect(`${origin}/?login=error`);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const savedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!clientId || !clientSecret || !code || !state || state !== savedState) {
    return fail();
  }

  try {
    const tokenUrl = new URL("https://nid.naver.com/oauth2.0/token");
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("state", state);
    const tokenRes = await fetch(tokenUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!tokenRes.ok || !token.access_token) return fail();

    const profileRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const profile = (await profileRes.json()) as {
      response?: { id?: string; name?: string; nickname?: string };
    };
    const user = profile.response;
    if (!profileRes.ok || !user?.id) return fail();

    const response = NextResponse.redirect(`${origin}/`);
    response.cookies.delete(STATE_COOKIE);
    response.cookies.set(
      SESSION_COOKIE,
      createSessionToken({
        id: user.id,
        name: user.name || user.nickname || "네이버 사용자",
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https://"),
        maxAge: SESSION_MAX_AGE_SECONDS,
        path: "/",
      },
    );
    return response;
  } catch {
    return fail();
  }
}
