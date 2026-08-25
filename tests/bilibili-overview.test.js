const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundScript = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);

function loadBackgroundTesting() {
  const context = vm.createContext({
    console,
    URL,
    TextEncoder,
    TextDecoder,
    importScripts() {},
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
          async remove() {},
          async setAccessLevel() {},
        },
      },
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
        async sendMessage() {
          return {};
        },
        getURL(file) {
          return file;
        },
      },
      action: { onClicked: { addListener() {} } },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        async query() {
          return [];
        },
        async get() {
          return { url: "https://www.bilibili.com/video/BV1xK4y1Q7tA" };
        },
        async sendMessage() {
          return { title: "", channelName: "", description: "" };
        },
      },
      sidePanel: {
        setOptions() {},
        open() {},
        setPanelBehavior() {},
      },
      scripting: { async executeScript() { return []; } },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize(value) {
        return value || {
          supadataApiKey: "",
          aiApiKey: "",
          aiModel: "deepseek-v4-flash",
          qwenApiKey: "",
          qwenModel: "qwen-vl-plus",
        };
      },
      chatCompletionsUrl() {
        return "https://api.deepseek.com/chat/completions";
      },
      qwenChatCompletionsUrl() {
        return "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
      },
      canonicalYouTubeUrl(videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      },
      selectModel(taskName) {
        const map = {
          screenshotSummary: { provider: "qwen", model: "qwen-vl-plus" },
          overview: { provider: "deepseek", model: "deepseek-v4-flash" },
          keynotes: { provider: "deepseek", model: "deepseek-v4-flash" },
        };
        return map[taskName] || { provider: "deepseek", model: "deepseek-v4-flash" };
      },
      getModelConfig(taskName, overrides = {}) {
        const m = this.selectModel(taskName);
        return {
          provider: overrides.provider || m.provider,
          model: overrides.model || m.model,
        };
      },
      getProviderEndpoint(provider) {
        return provider === "qwen"
          ? this.qwenChatCompletionsUrl()
          : this.chatCompletionsUrl();
      },
      getProviderApiKey(settings, provider) {
        if (provider === "qwen") return settings.qwenApiKey || "";
        return settings.aiApiKey || "";
      },
      TASK_MODELS: {},
    },
  });

  vm.runInContext(backgroundScript, context);
  return context;
}

test("buildOverview transforms analysis segments into UI-ready sections", () => {
  const bg = loadBackgroundTesting();
  const overview = bg.__BILI_OVERVIEW_TESTING__.buildOverview([
    { title: "极限的定义", timestamp: "00:10", timestampSeconds: 10, summary: "讲解极限的严格定义" },
    { title: "求导法则", timestamp: "02:30", timestampSeconds: 150, summary: "介绍常用求导公式" },
  ]);

  assert.ok(Array.isArray(overview.sections));
  assert.equal(overview.sections.length, 2);
  assert.equal(overview.sections[0].title, "极限的定义");
  assert.equal(overview.sections[0].timestamp, "00:10");
  assert.equal(overview.sections[1].timestampSeconds, 150);
});

test("buildOverview handles empty or invalid input", () => {
  const bg = loadBackgroundTesting();
  const fromNull = bg.__BILI_OVERVIEW_TESTING__.buildOverview(null);
  assert.equal(fromNull.sections.length, 0);
  const fromArray = bg.__BILI_OVERVIEW_TESTING__.buildOverview([]);
  assert.equal(fromArray.sections.length, 0);
  const fromObj = bg.__BILI_OVERVIEW_TESTING__.buildOverview({});
  assert.equal(fromObj.sections.length, 0);
});

test("buildOverview fills defaults for missing fields", () => {
  const bg = loadBackgroundTesting();
  const overview = bg.__BILI_OVERVIEW_TESTING__.buildOverview([
    { timestampSeconds: 30 },
  ]);

  assert.equal(overview.sections.length, 1);
  assert.match(overview.sections[0].title, /第.*段/);
  assert.equal(overview.sections[0].summary, "");
  assert.equal(overview.sections[0].timestampSeconds, 30);
});
