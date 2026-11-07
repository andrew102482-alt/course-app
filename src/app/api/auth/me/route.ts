import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSessionToken } from "@/lib/session";

/** 지금 로그인되어 있는지(이름만) 알려준다. */
export async function GET(request: NextRequest) {
  const user = readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ user: user ? { name: user.name } : null });
}
