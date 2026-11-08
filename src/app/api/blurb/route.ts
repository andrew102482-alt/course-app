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
const BLOG_URL = "https://naverapihub.apigw.ntruss.com/search/v1/blog";

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

async function blogSnippets(
  keyId: string,
  key: string,
  query: string,
): Promise<string[]> {
  try {
    const url = `${BLOG_URL}?query=${encodeURIComponent(query)}&display=3`;
    const res = await fetch(url, {
      headers: {
        "X-NCP-APIGW-API-KEY-ID": keyId,
        "X-NCP-APIGW-API-KEY": key,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: { title?: unknown; description?: unknown }[];
    };
    return (data.items ?? []).map(snippetOf).filter((s) => s.length > 3);
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
    if (!res.ok) return "";
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
  const blogKeyId = process.env.NAVER_HUB_KEY_ID;
  const blogKey = process.env.NAVER_HUB_KEY;
  if (!llmKey || !blogKeyId || !blogKey) {
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
    need.map((i) =>
      blogSnippets(blogKeyId, blogKey, `${places[i].n} ${area}`.trim()),
    ),
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
