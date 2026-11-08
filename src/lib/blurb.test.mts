import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBlurbUserMessage,
  cleanText,
  parseBlurbs,
  snippetOf,
} from "./blurb.ts";

test("cleanText strips tags, entities and risky characters", () => {
  assert.equal(cleanText('<b>어니언</b> &amp; "빵" | `x`', 50), "어니언 빵 x");
  assert.equal(cleanText("가나다라마", 3), "가나다");
  assert.equal(cleanText(5, 3), "");
});

test("snippetOf joins title and description within 220 chars", () => {
  const s = snippetOf({
    title: "<b>제목</b>",
    description: "내용".repeat(200),
  });
  assert.ok(s.startsWith("제목 — 내용"));
  assert.ok(s.length <= 220);
});

test("buildBlurbUserMessage skips places without snippets, keeps indexes", () => {
  const msg = buildBlurbUserMessage(
    [
      { n: "A", c: "카페" },
      { n: "B", c: "" },
      { n: "C", c: "갤러리" },
    ],
    { 0: ["a1", "a2"], 2: ["c1"] },
  );
  assert.equal(
    msg,
    "[0] A (분류: 카페)\n- a1\n- a2\n\n[2] C (분류: 갤러리)\n- c1",
  );
});

test("parseBlurbs tolerates surrounding text and drops bad indexes", () => {
  const m = parseBlurbs(
    '답변입니다 {"items":[{"k":0,"t":"좋아요."},{"k":"1","t":"x"},{"k":9,"t":"y"},{"k":2,"t":""}]} 끝',
    3,
  );
  assert.equal(m.get(0), "좋아요.");
  assert.equal(m.get(2), "");
  assert.equal(m.size, 2);
  assert.equal(parseBlurbs("not json", 3).size, 0);
});
