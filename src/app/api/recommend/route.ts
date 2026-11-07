import { NextResponse } from "next/server";
import {
  availableCatalog,
  buildFillPrompt,
  buildPlanPrompt,
  buildPrompt,
  countFillSlots,
  parseFill,
  parsePicks,
  parsePlan,
  type AiFillRequest,
  type AiPlanRequest,
  type AiRecommendRequest,
} from "@/lib/aiRecommend";

// API 키는 서버(이 파일)에서만 읽는다. 브라우저로 내려가지 않는다.
const BASE_URL = process.env.BAZE_BASE_URL ?? "https://api.baze.co/v1/gateway";
const MODEL = process.env.BAZE_MODEL ?? "claude-haiku-5-5";

export const maxDuration = 30;

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "course_picks",
    strict: true,
    schema: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              stageId: { type: "string" },
              placeId: { type: "string" },
            },
            required: ["stageId", "placeId"],
            additionalProperties: false,
          },
        },
      },
      required: ["picks"],
      additionalProperties: false,
    },
  },
} as const;

const PLAN_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "course_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: Object.keys(availableCatalog()),
              },
              subCategory: { type: "string" },
            },
            required: ["category", "subCategory"],
            additionalProperties: false,
          },
        },
      },
      required: ["stages"],
      additionalProperties: false,
    },
  },
} as const;

function isValidPlanRequest(body: unknown): body is AiPlanRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<AiPlanRequest>;
  return (
    b.mode === "plan" &&
    typeof b.themeNote === "string" &&
    b.themeNote.length <= 500
  );
}

function isValidFillRequest(body: unknown): body is AiFillRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<AiFillRequest>;
  if (b.mode !== "fill") return false;
  if (typeof b.themeNote !== "string" || b.themeNote.length > 500) return false;
  if (
    !Array.isArray(b.stages) ||
    b.stages.length === 0 ||
    b.stages.length > 12
  ) {
    return false;
  }
  const ok = b.stages.every(
    (s) =>
      s &&
      (s.label === null ||
        (typeof s.label === "string" && s.label.length <= 100)),
  );
  return ok && countFillSlots(b.stages) >= 1;
}

function isValidRequest(body: unknown): body is AiRecommendRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<AiRecommendRequest>;
  if (typeof b.themeNote !== "string" || b.themeNote.length > 500) return false;
  if (
    !Array.isArray(b.stages) ||
    b.stages.length === 0 ||
    b.stages.length > 12
  ) {
    return false;
  }
  return b.stages.every(
    (s) =>
      s &&
      typeof s.id === "string" &&
      typeof s.label === "string" &&
      (s.kind === "recommend" || s.kind === "designated") &&
      Array.isArray(s.candidates) &&
      s.candidates.length <= 20 &&
      s.candidates.every(
        (c) => typeof c?.id === "string" && typeof c?.name === "string",
      ),
  );
}

async function callGateway(
  apiKey: string,
  prompt: { system: string; user: string },
  schema: object | null,
): Promise<Response> {
  return fetch(`${BASE_URL}/chat/completions/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.3,
      max_tokens: 1024,
      ...(schema ? { response_format: schema } : {}),
    }),
    signal: AbortSignal.timeout(25_000),
  });
}

/** 구조화 출력(json_schema)을 먼저 시도하고, 모델이 지원하지 않아 400이 나오면 일반 응답으로 한 번 더 시도한다. */
async function askModel(
  apiKey: string,
  prompt: { system: string; user: string },
  schema: object,
): Promise<string | null> {
  let res = await callGateway(apiKey, prompt, schema);
  if (res.status === 400) res = await callGateway(apiKey, prompt, null);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function POST(request: Request) {
  const apiKey = process.env.BAZE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "not-configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  try {
    if (isValidPlanRequest(body)) {
      const text = await askModel(apiKey, buildPlanPrompt(body), PLAN_SCHEMA);
      if (text === null) {
        return NextResponse.json({ error: "upstream" }, { status: 502 });
      }
      return NextResponse.json({ stages: parsePlan(text) });
    }
    if (isValidFillRequest(body)) {
      const text = await askModel(apiKey, buildFillPrompt(body), PLAN_SCHEMA);
      if (text === null) {
        return NextResponse.json({ error: "upstream" }, { status: 502 });
      }
      return NextResponse.json({
        stages: parseFill(text, countFillSlots(body.stages)),
      });
    }
    if (!isValidRequest(body)) {
      return NextResponse.json({ error: "bad-request" }, { status: 400 });
    }
    const text = await askModel(apiKey, buildPrompt(body), RESPONSE_SCHEMA);
    if (text === null) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ picks: parsePicks(text, body) });
  } catch {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
