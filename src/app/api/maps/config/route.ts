import { connection, NextResponse } from "next/server";

// 지도 화면(브라우저)에는 Client ID만 내려준다. Secret은 이 서버 쪽에서만 쓴다.
export async function GET() {
  await connection();
  const clientId = process.env.NCP_MAPS_CLIENT_ID?.trim();
  return NextResponse.json({ clientId: clientId || null });
}
