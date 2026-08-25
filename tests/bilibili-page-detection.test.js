const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

function loadContentScript(url = "https://www.bilibili.com/video/BV1xK4y1Q7tA") {
  const context = vm.createContext({
    console,
    URL,
    document: {
      readyState: "loading",
      addEventListener() {},
      body: { appendChild() {} },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement() {
        return {
          style: {},
          addEventListener() {},
          setAttribute() {},
          appendChild() {},
          remove() {},
          querySelector() {
            return null;
          },
        };
      },
      getElementById() {
        return null;
      },
    },
    window: {
      location: new URL(url),
      addEventListener() {},
      getComputedStyle() {
        return { display: "flex", visibility: "visible" };
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() {
          return { success: true };
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  });

  vm.runInContext(contentScript, context);
  return context;
}

test("detects supported Bilibili and YouTube video URLs", () => {
  const context = loadContentScript();
  assert.equal(
    context.__BILI_TESTING__.isSupportedVideoUrl(
      "https://www.bilibili.com/video/BV1xK4y1Q7tA",
    ),
    true,
  );
  assert.equal(
    context.__BILI_TESTING__.isSupportedVideoUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ),
    true,
  );
  assert.equal(
    context.__BILI_TESTING__.isSupportedVideoUrl(
      "https://example.com/watch?v=dQw4w9WgXcQ",
    ),
    false,
  );
});

test("detects the active page type from window location", () => {
  const biliContext = loadContentScript(
    "https://www.bilibili.com/video/BV1xK4y1Q7tA",
  );
  const ytContext = loadContentScript(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );

  assert.equal(biliContext.__BILI_TESTING__.isBilibiliPage(), true);
  assert.equal(biliContext.__BILI_TESTING__.isYouTubePage(), false);
  assert.equal(ytContext.__BILI_TESTING__.isBilibiliPage(), false);
  assert.equal(ytContext.__BILI_TESTING__.isYouTubePage(), true);
});
