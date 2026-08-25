const test = require("node:test");
const assert = require("node:assert/strict");

// Test the pure parsing function without needing the full content script
function parseBilibiliSubtitleJson(subData) {
  if (!subData || !Array.isArray(subData.body)) return [];
  return subData.body.map((item) => ({
    text: String(item.content || "").trim(),
    start: Number(item.from) || Number(item.start) || 0,
    duration: Number(item.duration) || (Number(item.to) - Number(item.from)) || 0,
  }));
}

test("parses a standard Bilibili subtitle JSON body", () => {
  const result = parseBilibiliSubtitleJson({
    body: [
      { content: "今天我们来讲极限", from: 0, to: 3 },
      { content: "极限是高数的基础", from: 3, to: 6 },
      { content: "请大家注意这个定义", from: 6, to: 9 },
    ],
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].text, "今天我们来讲极限");
  assert.equal(result[0].start, 0);
  assert.equal(result[0].duration, 3);
  assert.equal(result[1].start, 3);
  assert.equal(result[2].duration, 3);
});

test("handles empty or malformed subtitle data", () => {
  assert.deepEqual(parseBilibiliSubtitleJson(null), []);
  assert.deepEqual(parseBilibiliSubtitleJson({}), []);
  assert.deepEqual(parseBilibiliSubtitleJson({ body: [] }), []);
  assert.deepEqual(parseBilibiliSubtitleJson({ body: "not an array" }), []);
});

test("handles entries with start field instead of from", () => {
  const result = parseBilibiliSubtitleJson({
    body: [
      { content: "测试", start: 10, duration: 2 },
    ],
  });

  assert.equal(result[0].start, 10);
  assert.equal(result[0].duration, 2);
});

test("handles entries with missing content", () => {
  const result = parseBilibiliSubtitleJson({
    body: [
      { from: 0, to: 2 },
      { content: "", from: 2, to: 4 },
      { content: "有效内容", from: 4, to: 6 },
    ],
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].text, "");
  assert.equal(result[1].text, "");
  assert.equal(result[2].text, "有效内容");
});

test("handles entries with only from and to (computes duration)", () => {
  const result = parseBilibiliSubtitleJson({
    body: [
      { content: "无duration字段", from: 5, to: 8 },
    ],
  });

  assert.equal(result[0].start, 5);
  assert.equal(result[0].duration, 3);
});

test("normalizes Bilibili subtitle segments to canonical transcript shape", () => {
  const segments = parseBilibiliSubtitleJson({
    body: [
      { content: "第一步", from: 0, to: 2 },
      { content: "第二步", from: 2, to: 4 },
      { content: "第三步", from: 4, to: 6 },
    ],
  });

  for (const seg of segments) {
    assert.equal(typeof seg.text, "string");
    assert.equal(typeof seg.start, "number");
    assert.equal(typeof seg.duration, "number");
    assert.ok(seg.duration >= 0);
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  assert.equal(totalDuration, 6);
});
