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
    setTimeout,
    clearTimeout,
    importScripts() {},
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
        return value || { supadataApiKey: "", aiApiKey: "", aiModel: "deepseek-v4-flash" };
      },
      chatCompletionsUrl() {
        return "https://api.deepseek.com/chat/completions";
      },
      canonicalYouTubeUrl(videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      },
    },
  });

  vm.runInContext(backgroundScript, context);
  return context;
}

test("builds a Bilibili note with screenshot and platform metadata", () => {
  const bg = loadBackgroundTesting();
  const note = bg.__BILI_NOTE_TESTING__.buildNote({
    platform: "bilibili",
    videoId: "BV1xK4y1Q7tA",
    timestamp: "02:05",
    timestampSeconds: 125,
    captionText: "这里是高数求导的重点",
    videoTitle: "高数基础课",
    channelName: "数学老师",
    videoUrl: "https://www.bilibili.com/video/BV1xK4y1Q7tA",
    screenshotDataUrl: "data:image/png;base64,abc",
    text: "这里是高数求导的重点",
  });

  assert.equal(note.sourcePlatform, "bilibili");
  assert.equal(note.videoId, "BV1xK4y1Q7tA");
  assert.equal(note.timestamp, "02:05");
  assert.equal(note.timestampSeconds, 125);
  assert.equal(note.captionText, "这里是高数求导的重点");
  assert.equal(note.screenshotDataUrl, "data:image/png;base64,abc");
  assert.equal(note.videoUrl, "https://www.bilibili.com/video/BV1xK4y1Q7tA");
  assert.equal(note.text, "这里是高数求导的重点");
});

test("falls back to timestamp formatting when note timestamp is omitted", () => {
  const bg = loadBackgroundTesting();
  const note = bg.__BILI_NOTE_TESTING__.buildNote({
    platform: "youtube",
    videoId: "dQw4w9WgXcQ",
    timestampSeconds: 9,
    captionText: "重点说明",
    videoTitle: "Example",
    channelName: "Channel",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    screenshotDataUrl: "",
    text: "重点说明",
  });

  assert.equal(note.timestamp, "0:09");
  assert.equal(note.sourcePlatform, "youtube");
  assert.equal(note.screenshotDataUrl, "");
});
