# B站课程学习笔记插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing YouTube Digest extension into a Chinese-first Bilibili course note plugin that supports transcript notes, video screenshots, overview summaries, and multi-model keypoint extraction.

**Architecture:** Reuse the current MV3 extension shell, side panel, and local-storage model, then add a Bilibili page adapter, a model-router layer, and a note pipeline that stores timestamp + caption + screenshot. Keep rules/heuristics responsible for fast deterministic work, route text tasks to DeepSeek by default, and route image-aware tasks to the alternate default model path so the product doubles as a practical multi-model experimentation harness.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, chrome.storage.local, chrome.tabs, chrome.scripting, side panel UI, existing prompt-file workflow, existing test runner (`node --test`).

## Global Constraints

- Chrome 116 或更高版本。
- 使用 `manifest_version: 3`。
- 保留用户自带 API Key 模式，不把密钥写入源码、日志、截图或提交记录。
- 所有用户数据继续只保存在本地 Chrome 存储中，不引入账号系统、分析统计或开发者服务器。
- 界面与文案以中文为主，面向 B 站网页课程学习场景。
- 第一版优先支持课程类、讲解类、题解类视频，不把通用视频支持作为目标。
- 保留本地可重载扩展的工作方式，不引入构建步骤。
- AI 任务按能力分层：规则任务优先、文本任务默认 DeepSeek、多模态任务默认千问。

---

### Task 1: Add Bilibili page detection and player messaging

**Files:**
- Modify: `content.js`
- Modify: `background.js`
- Modify: `manifest.json`
- Test: `tests/bilibili-page-detection.test.js`

**Interfaces:**
- Consumes: existing `openSidePanel`, `relayToContent`, `getVideoInfo`, `seekTo`, and `getCurrentTime` message patterns.
- Produces: Bilibili-aware content-script helpers, Bilibili tab detection, and a page-info payload that side panel code can consume without caring whether the page is YouTube or Bilibili.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { __BILI_TESTING__ } = require('../content.js');

test('detects Bilibili watch URLs', () => {
  assert.equal(__BILI_TESTING__.isSupportedVideoUrl('https://www.bilibili.com/video/BV1xK4y1Q7tA'), true);
  assert.equal(__BILI_TESTING__.isSupportedVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bilibili-page-detection.test.js`
Expected: FAIL because `__BILI_TESTING__.isSupportedVideoUrl` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add a small URL helper and Bilibili-specific guards in `content.js`, export them on `globalThis.__BILI_TESTING__`, and make background tab lookup accept `bilibili.com/video/*` in the same places it currently accepts YouTube.

```javascript
function isSupportedVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes('bilibili.com') &&
      parsed.pathname.startsWith('/video/')
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bilibili-page-detection.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add content.js background.js manifest.json tests/bilibili-page-detection.test.js
git commit -m "feat: add bilibili page detection"
```

---

### Task 2: Replace the YouTube-only note affordance with a Bilibili learning-note flow

**Files:**
- Modify: `content.js`
- Modify: `background.js`
- Modify: `sidepanel.js`
- Test: `tests/bilibili-note-flow.test.js`

**Interfaces:**
- Consumes: current `saveNote`, `showNoteSavedFeedback`, and note storage shape.
- Produces: note entries that include `timestamp`, `timestampSeconds`, `captionText`, `screenshotDataUrl`, `videoTitle`, `videoUrl`, and `sourcePlatform`.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { __BILI_NOTE_TESTING__ } = require('../background.js');

test('normalizes a Bilibili note payload', () => {
  const note = __BILI_NOTE_TESTING__.buildNote({
    platform: 'bilibili',
    videoId: 'BV1xK4y1Q7tA',
    timestampSeconds: 125,
    timestamp: '02:05',
    captionText: '这里是高数求导的重点',
    videoTitle: '高数基础课',
    videoUrl: 'https://www.bilibili.com/video/BV1xK4y1Q7tA',
    screenshotDataUrl: 'data:image/png;base64,abc',
  });

  assert.equal(note.sourcePlatform, 'bilibili');
  assert.equal(note.timestamp, '02:05');
  assert.equal(note.captionText, '这里是高数求导的重点');
  assert.equal(note.screenshotDataUrl, 'data:image/png;base64,abc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bilibili-note-flow.test.js`
Expected: FAIL because the note builder helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add a pure `buildNote()` helper in `background.js` that creates the final note object, then call it from `handleSaveNote()` after collecting the active caption line and screenshot.

```javascript
function buildNote(input) {
  return {
    id: `note_${Date.now()}`,
    sourcePlatform: input.platform,
    videoId: input.videoId,
    videoTitle: input.videoTitle,
    videoUrl: input.videoUrl,
    timestampSeconds: input.timestampSeconds,
    timestamp: input.timestamp,
    captionText: input.captionText,
    screenshotDataUrl: input.screenshotDataUrl,
    createdAt: Date.now(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bilibili-note-flow.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add content.js background.js sidepanel.js tests/bilibili-note-flow.test.js
git commit -m "feat: save bilibili notes with screenshots"
```

---

### Task 3: Add Bilibili transcript ingestion and sentence grouping

**Files:**
- Modify: `background.js`
- Modify: `sidepanel.js`
- Modify: `prompts/analysis.md`
- Modify: `prompts/note-cleanup.md`
- Test: `tests/bilibili-transcript-grouping.test.js`

**Interfaces:**
- Consumes: existing transcript fetch and grouping helpers.
- Produces: a Bilibili transcript array with stable segment IDs, Chinese-first labels, and the same click-to-seek behavior already used by the transcript panel.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { __BILI_TRANSCRIPT_TESTING__ } = require('../sidepanel.js');

test('groups caption fragments into learning segments', () => {
  const grouped = __BILI_TRANSCRIPT_TESTING__.groupTranscriptEntries([
    { text: '今天我们讲', start: 0, duration: 2 },
    { text: '高数的极限', start: 2, duration: 2 },
    { text: '这个知识点很重要。', start: 4, duration: 2 },
  ]);

  assert.ok(grouped.length >= 1);
  assert.match(grouped[0].text, /高数/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bilibili-transcript-grouping.test.js`
Expected: FAIL if the helper export is missing or grouping is not exposed for tests.

- [ ] **Step 3: Write minimal implementation**

Keep the existing grouping logic, expose a Bilibili-friendly test hook, and add a transcript ingestion function in `background.js` that can accept either native captions or a future ASR response without changing the side panel contract.

```javascript
function normalizeTranscriptEntries(entries) {
  return groupTranscriptEntries(entries || []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bilibili-transcript-grouping.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js sidepanel.js prompts/analysis.md prompts/note-cleanup.md tests/bilibili-transcript-grouping.test.js
git commit -m "feat: normalize bilibili transcript segments"
```

---

### Task 4: Add overview and keynote generation with model routing

**Files:**
- Modify: `background.js`
- Modify: `settings.js`
- Modify: `options.js`
- Modify: `sidepanel.js`
- Modify: `prompts/analysis.md`
- Test: `tests/model-routing.test.js`
- Test: `tests/bilibili-overview.test.js`

**Interfaces:**
- Consumes: `requestAiCompletion()`, `loadPromptSection()`, and existing analysis rendering.
- Produces: a model router that picks `deepseek` for text tasks and a separate default path for screenshot-aware tasks, plus an analysis object with `overview`, `keynotes`, and `keypoints` fields.

- [ ] **Step 1: Write the failing tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { __YTD_MODEL_TESTING__ } = require('../settings.js');

test('routes text tasks to deepseek and vision tasks to qwen', () => {
  assert.equal(__YTD_MODEL_TESTING__.selectModel('overview').provider, 'deepseek');
  assert.equal(__YTD_MODEL_TESTING__.selectModel('screenshot-summary').provider, 'qwen');
});
```

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { __BILI_OVERVIEW_TESTING__ } = require('../background.js');

test('builds an overview payload with timestamps and sections', () => {
  const overview = __BILI_OVERVIEW_TESTING__.buildOverview([
    { timestamp: '00:10', text: '这一节讲极限' },
    { timestamp: '02:30', text: '这里开始讲例题' },
  ]);

  assert.ok(Array.isArray(overview.sections));
  assert.equal(overview.sections.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model-routing.test.js tests/bilibili-overview.test.js`
Expected: FAIL because the router and overview builder are not exposed yet.

- [ ] **Step 3: Write minimal implementation**

Add a small `selectModel(taskName)` helper in `settings.js`, keep the default provider mapping in one place, and refactor analysis generation in `background.js` so it can emit `overview` and `keynotes` instead of the YouTube-centric chapter/quote naming.

```javascript
function selectModel(taskName) {
  if (taskName === 'screenshot-summary') {
    return { provider: 'qwen', model: 'qwen-vl-plus' };
  }
  return { provider: 'deepseek', model: 'deepseek-v4-flash' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model-routing.test.js tests/bilibili-overview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js settings.js sidepanel.js options.js prompts/analysis.md tests/model-routing.test.js tests/bilibili-overview.test.js
git commit -m "feat: add model routing for bilibili analysis"
```

---

### Task 5: Localize the UI for Chinese course learning and expose the new note vocabulary

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.css`
- Modify: `sidepanel.js`
- Modify: `options.html`
- Modify: `options.js`
- Modify: `README.zh-CN.md`
- Modify: `README.md`
- Test: `tests/options-language.test.js`

**Interfaces:**
- Consumes: existing bilingual UI copy workflow and local language storage.
- Produces: Chinese-first UI labels for Transcript / Overview / Keynotes / Notes, plus settings copy that explains DeepSeek for text and the alternate model path for image-aware tasks.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const { YTD_OPTIONS } = require('../options.js');

test('renders Chinese labels for the Bilibili learning note UI', () => {
  assert.match(YTD_OPTIONS.translate('zh-CN', 'pageTitle'), /设置/);
  assert.match(YTD_OPTIONS.translate('zh-CN', 'heading'), /使用你自己的 API 密钥/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/options-language.test.js`
Expected: FAIL if the new language strings are missing or not exported for test use.

- [ ] **Step 3: Write minimal implementation**

Add Chinese course-oriented labels and helper copy for the new model-routing behavior, then expose `YTD_OPTIONS` cleanly in Node tests.

```javascript
module.exports = YTD_OPTIONS;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/options-language.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel.html sidepanel.css sidepanel.js options.html options.js README.md README.zh-CN.md tests/options-language.test.js
git commit -m "feat: localize the bilibili learning note ui"
```

---

### Task 6: Update packaging, docs, and release checks for the Bilibili fork

**Files:**
- Modify: `manifest.json`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-release.sh`
- Modify: `scripts/package-extension.sh`
- Test: `tests/release.test.js`

**Interfaces:**
- Consumes: current release scripts and test coverage.
- Produces: packaging and documentation that reflect Bilibili support, Chinese UI wording, and the new multi-model positioning.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

test('manifest declares bilibili support in host permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.some((entry) => entry.includes('bilibili.com')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/release.test.js`
Expected: FAIL until the manifest and release docs are updated.

- [ ] **Step 3: Write minimal implementation**

Update the manifest, release notes, and docs to describe Bilibili support, Chinese-first note-taking, and the model split for text vs. screenshot tasks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run check && npm run package`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json PRIVACY.md SECURITY.md README.md README.zh-CN.md .github/workflows/ci.yml scripts/check-release.sh scripts/package-extension.sh tests/release.test.js
git commit -m "docs: update release assets for bilibili fork"
```

---

## Spec Coverage Check

- B站网页插件适配 → Task 1, Task 6
- 中文课程场景定位 → Task 5, Task 6
- Transcript 分句与时间戳 → Task 3
- 点击 note 记录时间戳 + 字幕 + 截图 → Task 2
- Overview 视频概览 → Task 4
- Keynotes 重点提取 → Task 4
- 多模型/多 agent 思路 → Task 4
- 本地存储与 BYOK 模式 → Task 2, Task 6
- 现有扩展结构复用 → 全部任务均基于现有文件增量修改

## Placeholder Scan

- No TBD/TODO placeholders remain in the plan.
- All tasks name exact files and provide runnable test commands.
- Every implementation step includes a concrete code shape or exact expected outcome.

## Type Consistency Check

- `selectModel(taskName)` is defined in Task 4 and reused only within that task.
- `buildNote(input)` is introduced in Task 2 and consumed by `handleSaveNote()` in the same task.
- `isSupportedVideoUrl(url)` is introduced in Task 1 and exported for Task 1 tests only.
- `groupTranscriptEntries(entries)` continues to match the existing side panel helper and is referenced consistently in Task 3.
- `YTD_OPTIONS.translate(language, key)` remains the language helper used by the options-page tests in Task 5.
