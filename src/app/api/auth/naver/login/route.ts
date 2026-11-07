import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

const STATE_COOKIE = "naver_state";

/** 네이버 로그인 화면으로 보낸다. state는 로그인 위조 방지용 임시 값이다. */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const clientId = process.env.NAVER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(`${origin}/?login=error`);
  }

  const state = randomBytes(16).toString("hex");
  const url = new URL("https://nid.naver.com/oauth2.0/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${origin}/api/auth/naver/callback`);
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    maxAge: 600,
    path: "/",
  });
  return response;
}
