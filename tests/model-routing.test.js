const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const settingsScript = fs.readFileSync(
  path.resolve(__dirname, "..", "settings.js"),
  "utf8",
);

function loadSettings() {
  const context = vm.createContext({
    console,
    module: { exports: {} },
  });
  vm.runInContext(settingsScript, context);
  return context.module.exports || context.YTD_SETTINGS;
}

test("routes text tasks to DeepSeek", () => {
  const YTD_SETTINGS = loadSettings();
  const overview = YTD_SETTINGS.selectModel("overview");
  assert.equal(overview.provider, "deepseek");
  assert.equal(overview.model, "deepseek-v4-flash");

  const keynotes = YTD_SETTINGS.selectModel("keynotes");
  assert.equal(keynotes.provider, "deepseek");

  const noteCleanup = YTD_SETTINGS.selectModel("noteCleanup");
  assert.equal(noteCleanup.provider, "deepseek");

  const translation = YTD_SETTINGS.selectModel("translation");
  assert.equal(translation.provider, "deepseek");
});

test("routes vision tasks to Qwen", () => {
  const YTD_SETTINGS = loadSettings();
  const screenshot = YTD_SETTINGS.selectModel("screenshotSummary");
  assert.equal(screenshot.provider, "qwen");
  assert.equal(screenshot.model, "qwen-vl-plus");

  const image = YTD_SETTINGS.selectModel("imageExplanation");
  assert.equal(image.provider, "qwen");

  const visual = YTD_SETTINGS.selectModel("visualKeypoints");
  assert.equal(visual.provider, "qwen");
});

test("falls back to DeepSeek for unknown tasks", () => {
  const YTD_SETTINGS = loadSettings();
  const unknown = YTD_SETTINGS.selectModel("someUnknownTask");
  assert.equal(unknown.provider, "deepseek");
  assert.equal(unknown.model, "deepseek-v4-flash");
});

test("getModelConfig allows overrides", () => {
  const YTD_SETTINGS = loadSettings();
  const defaultConfig = YTD_SETTINGS.getModelConfig("overview");
  assert.equal(defaultConfig.provider, "deepseek");

  const overridden = YTD_SETTINGS.getModelConfig("overview", {
    provider: "qwen",
    model: "qwen-vl-max",
  });
  assert.equal(overridden.provider, "qwen");
  assert.equal(overridden.model, "qwen-vl-max");
});

test("getProviderEndpoint returns correct URLs", () => {
  const YTD_SETTINGS = loadSettings();
  const deepSeekUrl = YTD_SETTINGS.getProviderEndpoint("deepseek");
  assert.match(deepSeekUrl, /api\.deepseek\.com/);
  assert.match(deepSeekUrl, /chat\/completions/);

  const qwenUrl = YTD_SETTINGS.getProviderEndpoint("qwen");
  assert.match(qwenUrl, /dashscope\.aliyuncs\.com/);
  assert.match(qwenUrl, /chat\/completions/);
});

test("getProviderApiKey picks the right key per provider", () => {
  const YTD_SETTINGS = loadSettings();
  const settings = {
    aiApiKey: "deepseek-key-123",
    qwenApiKey: "qwen-key-456",
  };

  assert.equal(
    YTD_SETTINGS.getProviderApiKey(settings, "deepseek"),
    "deepseek-key-123",
  );
  assert.equal(
    YTD_SETTINGS.getProviderApiKey(settings, "qwen"),
    "qwen-key-456",
  );
});

test("normalize includes qwen fields in settings", () => {
  const YTD_SETTINGS = loadSettings();
  const normalized = YTD_SETTINGS.normalize({
    aiApiKey: "ds-key",
    supadataApiKey: "sup-key",
    qwenApiKey: "qw-key",
  });

  assert.equal(normalized.aiApiKey, "ds-key");
  assert.equal(normalized.supadataApiKey, "sup-key");
  assert.equal(normalized.qwenApiKey, "qw-key");
  assert.equal(normalized.qwenModel, "qwen-vl-plus");
  assert.equal(normalized.qwenBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});
