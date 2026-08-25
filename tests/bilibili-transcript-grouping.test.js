const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sidepanelScript = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);

function loadSidepanelTesting() {
  const context = vm.createContext({
    console,
    URL,
    document: {
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    window: {
      location: new URL("https://www.bilibili.com/video/BV1xK4y1Q7tA"),
      addEventListener() {},
      close() {},
      scrollTo() {},
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() {
          return {};
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
          async remove() {},
        },
      },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        async query() {
          return [];
        },
        async sendMessage() {
          return {};
        },
      },
      windows: {
        async getCurrent() {
          return { id: 1 };
        },
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Math,
  });

  vm.runInContext(sidepanelScript, context);
  return context;
}

test("normalizes Bilibili caption payloads into the canonical transcript shape", () => {
  const sp = loadSidepanelTesting();
  const testing = sp.__YTD_TRANSCRIPT_TESTING__;

  const normalized = testing.normalizeTranscriptEntries([
    { text: "今天我们讲极限的定义", offset: 4000, duration: 2000, lang: "zh-CN" },
    { text: "  注意，这是重点。  ", offset: 6000, duration: 2000 },
    null,
    { text: "" },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].text, "今天我们讲极限的定义");
  assert.equal(normalized[0].start, 4);
  assert.equal(normalized[0].duration, 2);
  assert.equal(normalized[1].text, "注意，这是重点。");
});

test("groups a Bilibili math course into learning-sized Chinese segments", () => {
  const sp = loadSidepanelTesting();
  const testing = sp.__YTD_TRANSCRIPT_TESTING__;

  const grouped = testing.groupTranscriptEntries([
    { text: "今天我们来看一下高数的极限部分。", start: 0, duration: 3 },
    { text: "首先给出极限的定义。", start: 3, duration: 2 },
    { text: "对于任意的 ε 大于零，", start: 5, duration: 2 },
    { text: "存在 δ 大于零，", start: 7, duration: 2 },
    { text: "使得 0 小于 |x - a| 小于 δ。", start: 9, duration: 3 },
    { text: "|f(x) - L| 就小于 ε。", start: 12, duration: 2 },
    { text: "这里面有两个关键量。", start: 14, duration: 2 },
    { text: "一个是 ε，一个是 δ。", start: 16, duration: 2 },
    { text: "同学们一定要记住。", start: 18, duration: 2 },
    { text: "考试一定会考。", start: 20, duration: 2 },
  ]);

  assert.ok(grouped.length >= 2, "should produce learning-sized segments");
  for (const segment of grouped) {
    assert.ok(segment.id, "every segment needs a stable id");
    assert.ok(segment.id.startsWith("segment-"));
    assert.ok(segment.start >= 0);
    assert.ok(segment.text.length > 0);
  }

  const combined = grouped.map((segment) => segment.text).join(" ");
  assert.match(combined, /极限/);
  assert.match(combined, /ε/);
  assert.match(combined, /δ/);
});

test("splits a single oversized Bilibili ASR caption at Chinese punctuation", () => {
  const sp = loadSidepanelTesting();
  const testing = sp.__YTD_TRANSCRIPT_TESTING__;

  const longText =
    "第一步我们来求导，第二步我们对结果化简，第三步我们检查定义域是否需要分段讨论，第四步我们把最终答案写成简洁形式，第五步我们和老师给的参考解对比一下思路是否一致，第六步检查边界值是否被遗漏，第七步确认整个过程没有跳步，最后再核对一遍单位。";
  const parts = testing.splitOversizedThought(longText, 60);

  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.ok(part.length <= 60, `part too long: ${part.length}`);
  }
  assert.match(parts.join(""), /求导/);
  assert.match(parts.join(""), /检查定义域/);
});

test("normalization strips stray whitespace between Chinese characters", () => {
  const sp = loadSidepanelTesting();
  const testing = sp.__YTD_TRANSCRIPT_TESTING__;

  const normalized = testing.normalizeCaptionText(
    "今天  我们  讲  极限 ， 这是  重点 。",
  );
  assert.equal(normalized, "今天我们讲极限，这是重点。");
});

test("empty or malformed Bilibili transcript inputs do not crash grouping", () => {
  const sp = loadSidepanelTesting();
  const testing = sp.__YTD_TRANSCRIPT_TESTING__;

  // Cross-realm arrays in a vm context are not reference-identical to the
  // test realm's [], so compare lengths instead of deep equality.
  assert.equal(testing.groupTranscriptEntries([]).length, 0);
  assert.equal(testing.groupTranscriptEntries(null).length, 0);
  assert.equal(testing.groupTranscriptEntries([{ text: "" }]).length, 0);
  assert.equal(testing.groupTranscriptEntries([null, undefined]).length, 0);
});
