import { NextResponse } from "next/server";
import {
  BLURB_SYSTEM,
  MAX_BLURB_PLACES,
  blurbCacheKey,
  buildBlurbUserMessage,
  cleanText,
  parseBlurbs,
  snippetOf,
  type BlurbPlace,
} from "@/lib/blurb";

// 키는 서버에서만 읽는다. 블로그 원문은 LLM의 근거 자료로만 쓰고 화면에는 보내지 않는다.
const BASE_URL = process.env.BAZE_BASE_URL ?? "https://api.baze.co/v1/gateway";
const MODEL = process.env.BAZE_MODEL ?? "claude-haiku-5-5";
// 블로그 검색 키는 두 종류 중 있는 것을 쓴다.
// ① NAVER API HUB(NCP): NAVER_HUB_KEY_ID / NAVER_HUB_KEY
// ② 네이버 개발자센터 앱(로그인과 같은 키): NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (앱에 "검색" API 추가 필요)
const HUB_URL = "https://naverapihub.apigw.ntruss.com/search/v1/blog";
const OPEN_URL = "https://openapi.naver.com/v1/search/blog.json";

export const maxDuration = 60;

// 서버 메모리 캐시(재시작하면 사라짐). 빈 결과("")도 저장해 같은 장소를 다시 검색하지 않는다.
const cache = new Map<string, string>();
// IP당 60초에 20번까지.
const hits = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 20;
}

function parseRequest(
  body: unknown,
): { area: string; places: BlurbPlace[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { area?: unknown; places?: unknown };
  if (typeof b.area !== "string" || b.area.length > 30) return null;
  if (
    !Array.isArray(b.places) ||
    b.places.length === 0 ||
    b.places.length > MAX_BLURB_PLACES
  ) {
    return null;
  }
  const places: BlurbPlace[] = [];
  for (const p of b.places) {
    if (!p || typeof p.n !== "string" || p.n.length > 60) return null;
    places.push({
      n: cleanText(p.n, 60),
      c: typeof p.c === "string" ? cleanText(p.c, 40) : "",
    });
  }
  return { area: cleanText(b.area, 30), places };
}

type BlogAuth = { hub: boolean; keyId: string; key: string };

type BlogItems = { title?: unknown; description?: unknown }[];

/** 한 가지 방식(hub=NAVER API HUB / 아니면 개발자센터 openapi)으로 블로그 검색. 실패하면 상태 코드만 돌려준다. */
async function searchBlog(
  hub: boolean,
  auth: BlogAuth,
  query: string,
): Promise<{ status: number; items: BlogItems }> {
  const url = `${hub ? HUB_URL : OPEN_URL}?query=${encodeURIComponent(query)}&display=3`;
  const res = await fetch(url, {
    headers: hub
      ? {
          "X-NCP-APIGW-API-KEY-ID": auth.keyId,
          "X-NCP-APIGW-API-KEY": auth.key,
        }
      : {
          "X-Naver-Client-Id": auth.keyId,
          "X-Naver-Client-Secret": auth.key,
        },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 원인 파악용: 네이버가 돌려준 오류 문구만 서버 로그에 남긴다(키는 들어 있지 않다).
    const text = await res.text().catch(() => "");
    console.warn(`[blurb] naver says: ${text.slice(0, 200)}`);
    return { status: res.status, items: [] };
  }
  const data = (await res.json()) as { items?: BlogItems };
  return { status: 200, items: data.items ?? [] };
}

// 개발자센터 방식이 거절(401·403)되면 같은 키로 API HUB 방식을 시도하고, 통한 방식을 기억해 둔다.
let workingHub: boolean | null = null;

async function blogSnippets(auth: BlogAuth, query: string): Promise<string[]> {
  try {
    const order =
      workingHub !== null ? [workingHub] : auth.hub ? [true] : [false, true];
    for (const hub of order) {
      const { status, items } = await searchBlog(hub, auth, query);
      if (status === 200) {
        workingHub = hub;
        return items.map(snippetOf).filter((s) => s.length > 3);
      }
      console.warn(
        `[blurb] blog search failed: ${status} (${hub ? "hub" : "openapi"})`,
      );
      if (status !== 401 && status !== 403) break;
    }
    return [];
  } catch {
    return [];
  }
}

async function askLlm(apiKey: string, user: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: BLURB_SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        // Claude 계열은 response_format 없이 프롬프트 지시+파싱으로 처리한다.
        ...(MODEL.startsWith("claude")
          ? {}
          : { response_format: { type: "json_object" } }),
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) {
      console.warn(`[blurb] llm failed: ${res.status}`);
      return "";
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const llmKey = process.env.BAZE_API_KEY;
  const auth: BlogAuth | null =
    process.env.NAVER_HUB_KEY_ID && process.env.NAVER_HUB_KEY
      ? {
          hub: true,
          keyId: process.env.NAVER_HUB_KEY_ID,
          key: process.env.NAVER_HUB_KEY,
        }
      : process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET
        ? {
            hub: false,
            keyId: process.env.NAVER_CLIENT_ID,
            key: process.env.NAVER_CLIENT_SECRET,
          }
        : null;
  if (!llmKey || !auth) {
    return NextResponse.json({ error: "not-configured" }, { status: 503 });
  }
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "-";
  if (limited(ip)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const req = parseRequest(body);
  if (!req) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const { area, places } = req;
  const res = places.map((p) => cache.get(blurbCacheKey(p.n, area)));
  const need = res
    .map((r, i) => (r === undefined && places[i].n ? i : -1))
    .filter((i) => i >= 0);

  const found = await Promise.all(
    need.map((i) => blogSnippets(auth, `${places[i].n} ${area}`.trim())),
  );
  const snippets: Record<number, string[]> = {};
  need.forEach((i, j) => (snippets[i] = found[j]));

  const user = buildBlurbUserMessage(places, snippets);
  const got = user
    ? parseBlurbs(await askLlm(llmKey, user), places.length)
    : new Map<number, string>();
  for (const i of need) {
    const text = got.get(i) ?? "";
    res[i] = text;
    cache.set(blurbCacheKey(places[i].n, area), text);
  }
  return NextResponse.json({ items: res.map((r) => r ?? "") });
}
