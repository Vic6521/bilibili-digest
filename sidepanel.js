/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    // Lookahead-based merge so consecutive "汉字 汉字 汉字" chains fully
    // collapse instead of leaving every other space behind. ASR captions for
    // Chinese courses frequently carry these spaces around every character.
    .replace(/([\u3400-\u9fff])[\s]+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Normalizes a raw transcript payload (Supadata or future Bilibili ASR) into
 * the canonical shape the UI expects. Pure function so it can be unit-tested
 * and reused regardless of the source provider.
 */
function normalizeTranscriptEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  for (const entry of entries) {
    if (!entry) continue;
    const text = normalizeCaptionText(entry.text || entry.caption || "");
    if (!text) continue;
    const start = Number.isFinite(Number(entry.start))
      ? Number(entry.start)
      : Number.isFinite(Number(entry.offset))
        ? Number(entry.offset) / 1000
        : 0;

    // Duration is normalized to seconds. A millisecond payload (with offset
    // present, as in Bilibili ASR) converts duration alongside start; a
    // pre-normalized payload that already provides start in seconds keeps
    // its duration as-is.
    const rawDuration = Number(entry.duration) || 0;
    const durationSeconds = Number.isFinite(Number(entry.start))
      ? rawDuration
      : rawDuration / 1000;
    const duration = Math.max(0, durationSeconds);

    normalized.push({
      text,
      start,
      duration,
      language: entry.language || entry.lang || null,
    });
  }
  return normalized;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    const currentFilterVideoId = filterAll ? null : currentVideoId;
    loadNotes(currentFilterVideoId, true);
    if (document.querySelector('.tab-panel[data-panel="notes"]')?.classList.contains("active")) {
      switchTab("notes");
    }
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!isSupportedWatchUrl(url)) {
    // Panel is a course-video tool — remove itself from unsupported tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document
    .getElementById("reloadTranscriptBtn")
    ?.addEventListener("click", async () => {
      if (!currentVideoId) return;
      const reloadBtn = document.getElementById("reloadTranscriptBtn");
      if (reloadBtn) {
        reloadBtn.disabled = true;
        reloadBtn.textContent = "↻ 加载中…";
      }
      try {
        await clearCacheForVideo(currentVideoId);
      } catch (e) {
        debugLog("[Bilibili Digest] Cache clear failed:", e);
      }
      await startDigest(currentVideoId, currentVideoUrl);
      if (reloadBtn) {
        reloadBtn.disabled = false;
        reloadBtn.textContent = "↻ 重新加载";
      }
    });
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesRefreshBtn")?.addEventListener("click", async () => {
    const refreshButton = document.getElementById("notesRefreshBtn");
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "↻ 加载中";
    }
    const notesPanelVideoId = currentVideoId;
    const isAll = document.getElementById("notesFilterAll")?.classList.contains("active");
    if (isAll) {
      await loadNotes(null, true);
    } else {
      await loadNotes(notesPanelVideoId, true);
    }
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = "↻ 刷新";
    }
  });
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
  document
    .getElementById("notesExportPdfBtn")
    ?.addEventListener("click", () => {
      exportNotesPdf();
    });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // Try multiple strategies to find the YouTube tab
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url && isSupportedWatchUrl(tabs[0].url)) {
      tab = tabs[0];
    }

    // Strategy 2: Any active supported tab
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.youtube.com/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.bilibili.com/video/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any supported tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[Bilibili Digest Panel] Found tab:", tab?.id, tab?.url);

      if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    if (urlObj.hostname.includes("bilibili.com") && urlObj.pathname.startsWith("/video/")) {
      const bvid = urlObj.pathname.split("/")[2] || null;
      if (!bvid) return null;
      const part = urlObj.searchParams.get("p");
      return part ? `${bvid}_p${part}` : bvid;
    }

    return null;
  } catch {
    return null;
  }
}

function isSupportedWatchUrl(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes("youtube.com")) {
      return urlObj.searchParams.has("v") || urlObj.pathname.startsWith("/watch");
    }
    return urlObj.hostname.includes("bilibili.com") && urlObj.pathname.startsWith("/video/");
  } catch {
    return false;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("正在提取字幕", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
    videoUrl: videoUrl,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "字幕暂不可用",
        "该视频暂时无法获取字幕，你可以尝试截图笔记功能。",
      );
      return;
    }

    if (transcriptResult.fallbackMode === "screenshot") {
      showScreenshotFallback(transcriptResult.message);
      return;
    }

    showError(
      "没有找到字幕",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;
  const subtitleAllTracks = Array.isArray(transcriptResult.allTracks)
    ? transcriptResult.allTracks
    : [];
  const hasAiOnlyTrack =
    subtitleAllTracks.length > 0 &&
    subtitleAllTracks.every((track) => String(track.languageCode || "").includes("ai"));
  if (hasAiOnlyTrack) {
    showToast("检测到 AI 字幕，可能不够准确。");
  }

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="保存为笔记">📝 笔记</button>
          <button class="quote-copy-btn" title="复制引用">⧉ 复制</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ 已复制";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ 复制";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "保存中…";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ 已保存";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "保存失败";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "保存失败";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const isAiSubtitle = String(currentTranscriptLanguage || "").toLowerCase().includes("ai");
  const subtitleLabel = isAiSubtitle
    ? `${escapeHtml(getOriginalTranscriptLabel())} · AI subtitle, may be inaccurate`
    : escapeHtml(getOriginalTranscriptLabel());
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${subtitleLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
      <button class="transcript-screenshot-btn" title="截图保存笔记">📸</button>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );

    const screenshotBtn = div.querySelector(".transcript-screenshot-btn");
    screenshotBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await saveTranscriptLineAsNote(group);
    });

    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl = currentVideoUrl || `https://www.youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by Bilibili Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "重试";
}

function showScreenshotFallback(message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = "没有可用字幕";
  document.getElementById("errorMessage").textContent =
    message || "该视频没有字幕轨道。你可以使用截图笔记功能：把鼠标移到视频上，点击 Note 按钮保存关键帧。";
  document.getElementById("errorBtn").textContent = "打开笔记页";
  errorAction = () => switchTab("notes");
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");
  if (!configStatus.hasQwenKey) missingKeys.push("Qwen");

  showState("error");
  document.getElementById("errorTitle").textContent = "缺少 API 密钥";
  document.getElementById("errorMessage").textContent =
    `请先在设置中填写：${missingKeys.join("、")}。`;
  document.getElementById("errorBtn").textContent = "打开设置";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">正在加载章节…</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">正在加载引用…</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">分析失败：${escapeHtml(analysisResult.error || "未知错误")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">错误：${escapeHtml(error.message)}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

async function saveTranscriptLineAsNote(group) {
  if (!currentVideoId) return;

  await seekTo(group.start);

  await new Promise((resolve) => setTimeout(resolve, 400));

  let screenshotDataUrl = null;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "captureScreenshot" },
    });
    if (result?.success) {
      screenshotDataUrl = result.screenshotDataUrl;
    }
  } catch (err) {
    debugLog("[YouTube Digest] Screenshot capture failed:", err);
  }

  try {
    const noteResult = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: group.start,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      screenshotDataUrl,
      sourcePlatform: currentVideoUrl?.includes("bilibili.com") ? "bilibili" : "youtube",
      videoUrl: currentVideoUrl,
    });

    if (noteResult?.success) {
      loadNotes(currentVideoId);
    }
  } catch (err) {
    console.error("[YouTube Digest] Save transcript line as note failed:", err);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function renderNotebookMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return "";

  const mathBlocks = [];
  const blockPlaceholder = source.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expr) => {
    const id = mathBlocks.push(String(expr).trim()) - 1;
    return `@@MATH_BLOCK_${id}@@`;
  });

  const lines = blockPlaceholder.split("\n");
  const rendered = [];
  let inList = false;
  let inCode = false;
  let codeBuffer = [];

  const closeList = () => {
    if (inList) {
      rendered.push("</ul>");
      inList = false;
    }
  };

  const closeCode = () => {
    if (inCode) {
      rendered.push(`<pre class="note-code-block">${escapeHtml(codeBuffer.join("\n"))}</pre>`);
      codeBuffer = [];
      inCode = false;
    }
  };

  const renderInline = (value) =>
    escapeHtml(latexToUnicode(value))
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\$([^$\n]+)\$/g, (_m, expr) => `<span class="note-math-inline">${escapeHtml(latexToUnicode(expr))}</span>`);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```(?:\w+)?\s*$/.test(line)) {
      if (inCode) closeCode();
      else {
        closeList();
        inCode = true;
        codeBuffer = [];
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      rendered.push('<div class="note-paragraph-spacer"></div>');
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      rendered.push(`<div class="note-h${level}">${renderInline(heading[2])}</div>`);
      continue;
    }

    const ordered = line.match(/^\s*(\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ordered || bullet) {
      if (!inList) {
        rendered.push('<ul class="note-list">');
        inList = true;
      }
      const content = renderInline((ordered || bullet)[2] || (ordered || bullet)[1]);
      rendered.push(`<li>${content}</li>`);
      continue;
    }

    closeList();
    rendered.push(`<div class="note-paragraph">${renderInline(line)}</div>`);
  }

  closeList();
  closeCode();

  let html = rendered.join("");
  html = html.replace(/@@MATH_BLOCK_(\d+)@@/g, (_m, index) => {
    const expr = mathBlocks[Number(index)] || "";
    return `<div class="note-math-block">${escapeHtml(latexToUnicode(expr))}</div>`;
  });
  return html;
}

/**
 * Converts common LaTeX commands into readable Unicode symbols so notes
 * display like board notes instead of raw code. Unknown commands are left
 * intact (they are usually already plain text).
 */
function latexToUnicode(value) {
  let text = String(value || "");

  // Strip explicit display markers and \displaystyle
  text = text.replace(/\$\$/g, "").replace(/\$/g, "");
  text = text.replace(/\\displaystyle\s*/g, "").replace(/\\limits\s*/g, "");

  // \text{...}, \mathrm{...} -> inner content
  text = text.replace(/\\(?:text|mathrm|textbf|textit|operatorname)\{([^{}]*)\}/g, "$1");

  // \frac{a}{b} -> a/b
  text = text.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, num, den) => `(${num})/(${den})`);

  // \sqrt{x} -> √x
  text = text.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");

  // \lim_{x \to \infty} -> lim(x→∞)
  text = text.replace(/\\lim_?\{?([^{}\n]*)\}?/g, (_, sub) =>
    sub ? `lim(${sub.replace(/\\to/g, "→").replace(/\\infty/g, "∞")})` : "lim",
  );

  // \sum_{i=1}^{n} -> Σ
  text = text.replace(/\\sum_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "Σ");
  text = text.replace(/\\prod_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "∏");
  text = text.replace(/\\int_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "∫");

  // \alpha..\omega etc (Greek letters)
  const greek = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
    varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
    pi: "π", varpi: "π", rho: "ρ", sigma: "σ", varsigma: "ς",
    tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ",
    psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
    Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  };
  for (const [cmd, symbol] of Object.entries(greek)) {
    text = text.replace(new RegExp(`\\\\${cmd}\\b`, "g"), symbol);
  }

  // Relations & operators
  const symbols = {
    "\\to": "→", "\\rightarrow": "→", "\\Rightarrow": "⇒", "\\Longrightarrow": "⟹",
    "\\leftarrow": "←", "\\Leftarrow": "⇐", "\\Leftrightarrow": "⇔", "\\iff": "⇔",
    "\\leq": "≤", "\\leqslant": "≤", "\\le": "≤", "\\geq": "≥", "\\geqslant": "≥",
    "\\ge": "≥", "\\neq": "≠", "\\ne": "≠", "\\approx": "≈", "\\sim": "~",
    "\\in": "∈", "\\notin": "∉", "\\subset": "⊂", "\\subseteq": "⊆",
    "\\supset": "⊃", "\\supseteq": "⊇", "\\cup": "∪", "\\cap": "∩",
    "\\forall": "∀", "\\exists": "∃", "\\infty": "∞", "\\partial": "∂",
    "\\cdot": "·", "\\times": "×", "\\div": "÷", "\\pm": "±", "\\mp": "∓",
    "\\circ": "∘", "\\bullet": "•", "\\dots": "…", "\\cdots": "⋯",
    "\\equiv": "≡", "\\propto": "∝", "\\langle": "⟨", "\\rangle": "⟩",
    "\\emptyset": "∅", "\\varnothing": "∅", "\\angle": "∠", "\\perp": "⊥",
    "\\parallel": "∥", "\\triangle": "△", "\\therefore": "∴", "\\because": "∵",
    "\\prime": "′", "\\deg": "°", "\\hbar": "ℏ",
  };
  for (const [cmd, symbol] of Object.entries(symbols)) {
    text = text.split(cmd).join(symbol);
  }

  // Subscript/superscript markers to readable form: x^2 stays x^2, but strip
  // braces: a_{n} -> a_n, x^{2} -> x^2
  text = text.replace(/\^\{([^{}]*)\}/g, "^$1");
  text = text.replace(/_\{([^{}]*)\}/g, "_$1");

  // Strip \left \right \big etc. sizing commands
  text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "");

  // \begin{cases} ... \end{cases} -> readable rows
  text = text.replace(/\\begin\{cases\}/g, "{");
  text = text.replace(/\\end\{cases\}/g, "}");
  text = text.replace(/\\begin\{[^{}]*\}/g, "");
  text = text.replace(/\\end\{[^{}]*\}/g, "");
  text = text.replace(/\\\\/g, "\n");

  // Strip remaining stray commands (e.g. \quad, \;, \,, \! )
  text = text.replace(/\\(?:quad|qquad|;|,|!|:|space|hspace\{[^{}]*\})/g, " ");

  // Collapse multiple spaces
  text = text.replace(/[ \t]{2,}/g, " ");

  return text.trim();
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ 已复制";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Clears the cached digest for a specific video, forcing a fresh fetch
 * on the next startDigest() call. Used by the Reload button.
 */
async function clearCacheForVideo(videoId) {
  if (!videoId) return;
  try {
    await chrome.storage.local.remove(`digest_${videoId}`);
    debugLog("[Bilibili Digest] Cleared cache for:", videoId);
  } catch (error) {
    console.error("[Bilibili Digest] Cache clear error:", error);
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId, forceRefresh = false) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
      forceRefresh,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
      const refreshButton = document.getElementById("notesRefreshBtn");
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = "↻ 刷新";
      }
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 * When chapter analysis exists, notes are organized into:
 *   - 大标题: 课程名称
 *   - 一级标题: 视频章节 / 模块
 *   - 二级标题: 章节内更细的知识点（按笔记时间戳拆分）
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  const hasNotes = Array.isArray(notes) && notes.length > 0;
  notesIntro.style.display = hasNotes ? "none" : "block";
  if (!hasNotes && !currentAnalysis?.chapters?.length) {
    notesIntro.textContent = filteredVideoId
      ? "当前视频还没有笔记。把鼠标移到视频上，点击 📝 笔记保存。"
      : "还没有保存任何笔记。把鼠标移到视频上，点击 📝 笔记保存。";
    return;
  }

  // Keep the chapter outline visible even before the first note is saved.
  notes = Array.isArray(notes) ? notes : [];

  const sortedNotes = [...notes].sort(
    (a, b) => (Number(a.timestampSeconds) || 0) - (Number(b.timestampSeconds) || 0),
  );

  const chapters = (currentAnalysis?.chapters || []).filter(
    (c) => c.timestampSeconds !== undefined,
  );
  const canGroupByChapters = filteredVideoId && chapters.length > 0;

  if (canGroupByChapters) {
    const courseTitle = document.createElement("div");
    courseTitle.className = "notes-course-title";
    courseTitle.textContent = currentVideoTitle || "当前课程";
    notesList.appendChild(courseTitle);

    chapters.forEach((chapter, chapterIdx) => {
      const chapterStart = Number(chapter.timestampSeconds) || 0;
      const nextChapterStart = chapters[chapterIdx + 1]
        ? Number(chapters[chapterIdx + 1].timestampSeconds) || Infinity
        : Infinity;

      const chapterNotes = sortedNotes.filter((note) => {
        const t = Number(note.timestampSeconds) || 0;
        return t >= chapterStart && t < nextChapterStart;
      });

      const chapterSection = document.createElement("div");
      chapterSection.className = "notes-chapter-section";

      const chapterHeading = document.createElement("div");
      chapterHeading.className = "notes-chapter-heading";
      chapterHeading.innerHTML = `
        <span class="notes-chapter-time">${escapeHtml(chapter.timestamp)}</span>
        <span class="notes-chapter-title">${escapeHtml(chapter.title)}</span>
      `;
      chapterHeading.addEventListener("click", () => {
        seekTo(chapterStart);
      });
      chapterHeading.style.cursor = "pointer";
      chapterSection.appendChild(chapterHeading);

      if (chapter.summary) {
        const subSection = document.createElement("div");
        subSection.className = "notes-subsection-heading";
        subSection.textContent = chapter.summary;
        chapterSection.appendChild(subSection);
      }

      if (chapterNotes.length > 0) {
        chapterNotes.forEach((note, noteIdx) => {
          const pointWrap = document.createElement("div");
          pointWrap.className = "notes-subpoint";

          const pointTitle = document.createElement("div");
          pointTitle.className = "notes-subpoint-heading";
          pointTitle.innerHTML = `
            <span class="notes-subpoint-index">${chapterIdx + 1}.${noteIdx + 1}</span>
            <span class="notes-subpoint-title">${escapeHtml(buildNotePointTitle(note, noteIdx + 1))}</span>
            <span class="notes-subpoint-time">${escapeHtml(note.timestamp || formatTimestamp(Number(note.timestampSeconds) || 0))}</span>
          `;
          pointWrap.appendChild(pointTitle);

          pointWrap.appendChild(createNoteElement(note, filteredVideoId));
          chapterSection.appendChild(pointWrap);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "notes-chapter-empty";
        empty.textContent = "这个部分还没有笔记，可以在下方直接输入知识点。";
        chapterSection.appendChild(empty);
      }

      chapterSection.appendChild(createAddPointEditor(chapterStart, chapterIdx + 1));

      notesList.appendChild(chapterSection);
    });

    const preChapterNotes = sortedNotes.filter(
      (note) =>
        (Number(note.timestampSeconds) || 0) <
        (Number(chapters[0]?.timestampSeconds) || 0),
    );
    if (preChapterNotes.length > 0) {
      const preSection = document.createElement("div");
      preSection.className = "notes-chapter-section";
      const preHeading = document.createElement("div");
      preHeading.className = "notes-chapter-heading";
      preHeading.innerHTML = `<span class="notes-chapter-title">章节前内容</span>`;
      preSection.appendChild(preHeading);
      preChapterNotes.forEach((note, noteIdx) => {
        const pointWrap = document.createElement("div");
        pointWrap.className = "notes-subpoint";
        const pointTitle = document.createElement("div");
        pointTitle.className = "notes-subpoint-heading";
        pointTitle.innerHTML = `
          <span class="notes-subpoint-index">0.${noteIdx + 1}</span>
          <span class="notes-subpoint-title">${escapeHtml(buildNotePointTitle(note, noteIdx + 1))}</span>
          <span class="notes-subpoint-time">${escapeHtml(note.timestamp || formatTimestamp(Number(note.timestampSeconds) || 0))}</span>
        `;
        pointWrap.appendChild(pointTitle);
        pointWrap.appendChild(createNoteElement(note, filteredVideoId));
        preSection.appendChild(pointWrap);
      });
      notesList.insertBefore(preSection, notesList.firstChild);
    }
  } else {
    const courseTitle = document.createElement("div");
    courseTitle.className = "notes-course-title";
    courseTitle.textContent = currentVideoTitle || "当前课程";
    notesList.appendChild(courseTitle);

    sortedNotes.forEach((note, idx) => {
      const pointWrap = document.createElement("div");
      pointWrap.className = "notes-subpoint";
      const pointTitle = document.createElement("div");
      pointTitle.className = "notes-subpoint-heading";
      pointTitle.innerHTML = `
        <span class="notes-subpoint-index">${idx + 1}</span>
        <span class="notes-subpoint-title">${escapeHtml(buildNotePointTitle(note, idx + 1))}</span>
        <span class="notes-subpoint-time">${escapeHtml(note.timestamp || formatTimestamp(Number(note.timestampSeconds) || 0))}</span>
      `;
      pointWrap.appendChild(pointTitle);
      pointWrap.appendChild(createNoteElement(note, filteredVideoId));
      notesList.appendChild(pointWrap);
    });
  }
}

function buildNotePointTitle(note, index) {
  const raw = String(note.text || note.captionText || "").trim();
  if (!raw) return `小点 ${index}`;
  const firstLine = raw
    .replace(/^#{1,6}\s+/gm, "")
    .split(/[。！？.!?\n]/)[0]
    .trim();
  const snippet = firstLine || raw.replace(/^#{1,6}\s+/gm, "").trim();
  return snippet.length > 28 ? `${snippet.slice(0, 28)}…` : snippet;
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Creates an inline "add knowledge point" editor for a chapter. The notes
 * page starts with the full outline (大标题 → 章节 → 知识点分点) even before
 * the user saves anything; typing here persists a note at the chapter time.
 */
function createAddPointEditor(chapterStartSeconds, chapterNumber) {
  const wrap = document.createElement("div");
  wrap.className = "notes-addpoint";

  const textarea = document.createElement("textarea");
  textarea.className = "notes-addpoint-input";
  textarea.placeholder = `输入第 ${chapterNumber} 部分的知识点内容，点击保存后加入笔记…`;
  textarea.rows = 2;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "note-action-btn notes-addpoint-save";
  saveBtn.textContent = "＋ 添加知识点";

  const statusEl = document.createElement("span");
  statusEl.className = "notes-addpoint-status";

  const doSave = async () => {
    const text = textarea.value.trim();
    if (!text) {
      statusEl.textContent = "请先输入内容";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      const result = await chrome.runtime.sendMessage({
        action: "addNote",
        videoId: currentVideoId,
        timestamp: chapterStartSeconds,
        videoTitle: currentVideoTitle,
        channelName: currentChannelName,
        sourcePlatform: currentVideoUrl?.includes("bilibili.com") ? "bilibili" : "youtube",
        videoUrl: currentVideoUrl,
        text,
      });
      if (result?.success) {
        textarea.value = "";
        statusEl.textContent = "✓ 已添加";
        loadNotes(currentVideoId, true);
        return;
      }
      statusEl.textContent = `⚠ ${result?.error || "保存失败"}`;
    } catch (err) {
      statusEl.textContent = "⚠ 保存失败";
    }
    saveBtn.disabled = false;
    saveBtn.textContent = "＋ 添加知识点";
  };

  saveBtn.addEventListener("click", doSave);
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      doSave();
    }
  });

  wrap.appendChild(textarea);
  wrap.appendChild(saveBtn);
  wrap.appendChild(statusEl);
  return wrap;
}

/**
 * Creates a single note element with all buttons and event listeners.
 */
function createNoteElement(note, filteredVideoId) {
  const noteEl = document.createElement("div");
  noteEl.className = "note-item";
  const hasOcrText = Boolean(note.ocrText && note.ocrText.trim());
  noteEl.innerHTML = `
    <div class="note-header">
      <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
      ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
      <button class="note-delete" data-id="${escapeHtml(note.id)}" title="删除笔记">✕</button>
    </div>
    ${hasOcrText ? `
      <div class="note-ocr-text">
        <div class="note-ocr-label">截图识别文字</div>
        <div class="note-ocr-content">${renderNotebookMarkdown(note.ocrText)}</div>
      </div>` : ""}
    <div class="note-text note-text-editor" contenteditable="true" spellcheck="false" data-note-id="${escapeHtml(note.id)}">${renderNotebookMarkdown(note.text || note.captionText || "")}</div>
    ${note.screenshotDataUrl ? `
      <div class="note-screenshot-wrap">
        <img class="note-screenshot" src="${escapeHtml(note.screenshotDataUrl)}" alt="${escapeHtml(note.timestamp)} 的截图" />
        <button class="note-action-btn note-ocr-btn" type="button">${hasOcrText ? "↻ 重新识别" : "🔍 识别截图文字"}</button>
      </div>` : ""}
    <div class="note-actions">
      <button class="note-action-btn note-save-text" type="button" style="display:none">💾 保存修改</button>
      <button class="note-action-btn note-copy-text">⧉ 复制文字</button>
      <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl || note.videoUrl || "")}">🔗 复制时间戳</button>
      <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ 播放</button>
    </div>
  `;

  noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
    playNote(note);
  });

  noteEl
    .querySelector(".note-delete")
    .addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteNote(note.id);
      loadNotes(filteredVideoId, true);
    });

  // Inline editing: show the save button whenever the text is edited, then
  // persist it back through the same OCR/note-update path.
  const noteText = noteEl.querySelector(".note-text");
  const saveTextBtn = noteEl.querySelector(".note-save-text");
  const originalText = note.text || note.captionText || "";

  const handleEdit = () => {
    const changed = noteText.innerText.trim() !== originalText.trim();
    saveTextBtn.style.display = changed ? "" : "none";
  };

  noteText.addEventListener("input", handleEdit);
  noteText.addEventListener("blur", () => {
    setTimeout(handleEdit, 0);
  });

  saveTextBtn.addEventListener("click", async () => {
    const newText = noteText.innerText.trim();
    try {
      const updateResult = await chrome.runtime.sendMessage({
        action: "updateNoteText",
        noteId: note.id,
        text: newText,
      });
      if (updateResult?.success) {
        note.text = newText;
        saveTextBtn.textContent = "✓ 已保存";
        saveTextBtn.disabled = true;
        setTimeout(() => {
          saveTextBtn.textContent = "💾 保存修改";
          saveTextBtn.disabled = false;
          saveTextBtn.style.display = "none";
        }, 1200);
      } else {
        saveTextBtn.textContent = "⚠ 保存失败";
      }
    } catch (err) {
      saveTextBtn.textContent = "⚠ 保存失败";
    }
  });

  noteEl
    .querySelector(".note-copy-text")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.text || note.captionText || "");
        const btn = noteEl.querySelector(".note-copy-text");
        btn.textContent = "✓ 已复制";
        setTimeout(() => {
          btn.textContent = "⧉ 复制文字";
        }, 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

  noteEl
    .querySelector(".note-copy-link")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.timestampedUrl || note.videoUrl || "");
        const btn = noteEl.querySelector(".note-copy-link");
        btn.textContent = "✓ 已复制";
        setTimeout(() => {
          btn.textContent = "🔗 复制时间戳";
        }, 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

  noteEl.querySelector(".note-play").addEventListener("click", () => {
    playNote(note);
  });

  // OCR button — extract text from the note screenshot
  const ocrBtn = noteEl.querySelector(".note-ocr-btn");
  if (ocrBtn) {
    ocrBtn.addEventListener("click", async () => {
      ocrBtn.disabled = true;
      ocrBtn.textContent = "识别中…";
      try {
        const ocrResult = await chrome.runtime.sendMessage({
          action: "ocrScreenshot",
          screenshotDataUrl: note.screenshotDataUrl,
          videoTitle: note.videoTitle,
        });
        if (ocrResult?.success && ocrResult.text) {
          const updateResult = await chrome.runtime.sendMessage({
            action: "updateNoteText",
            noteId: note.id,
            text: ocrResult.text,
          });
          if (updateResult?.success) {
            loadNotes(filteredVideoId, true);
            return;
          } else {
            ocrBtn.textContent = "⚠ 更新失败";
          }
        } else {
          const errCode = ocrResult?.error;
          if (errCode === "NO_QWEN_KEY") {
            ocrBtn.textContent = "⚠ 未配置 Qwen Key";
          } else {
            ocrBtn.textContent = `⚠ 识别失败`;
          }
        }
      } catch (err) {
        ocrBtn.textContent = "⚠ 识别失败";
      }
      setTimeout(() => {
        if (ocrBtn.isConnected) {
          ocrBtn.disabled = false;
          ocrBtn.textContent = "🔍 识别截图文字";
        }
      }, 3000);
    });
  }

  return noteEl;
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// NOTES EXPORT — Print-friendly PDF document
// ============================================================

/**
 * Builds a self-contained print-ready HTML document from the notes list.
 * Mirrors the on-screen hierarchy: 课程名 → 章节 → 知识点分点.
 */
function buildNotesExportHtml(notes, filteredVideoId, courseTitleOverride, exportDateOverride) {
  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const formatTime = (totalSeconds) => {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const sortedNotes = [...(notes || [])].sort(
    (a, b) => (Number(a.timestampSeconds) || 0) - (Number(b.timestampSeconds) || 0),
  );

  const chapters = (currentAnalysis?.chapters || []).filter(
    (c) => c.timestampSeconds !== undefined,
  );

  const courseTitle = courseTitleOverride
    ? courseTitleOverride
    : filteredVideoId
      ? currentVideoTitle || "当前课程"
      : "全部笔记";

  const bodySections = [];

  const renderNote = (note, index) => {
    const text = String(note.text || note.captionText || "").trim();
    const ocrText = String(note.ocrText || "").trim();
    const hasScreenshot = Boolean(note.screenshotDataUrl);
    const timestamp = note.timestamp || formatTime(note.timestampSeconds);
    return `
      <div class="note-block">
        <div class="note-point-label">知识点 ${index}</div>
        ${text ? `<div class="note-text">${escapeHtml(text)}</div>` : ""}
        ${ocrText ? `
          <div class="note-ocr">
            <div class="note-ocr-label">截图识别文字</div>
            <div>${escapeHtml(ocrText)}</div>
          </div>` : ""}
        ${hasScreenshot ? `<img class="note-img" src="${escapeHtml(note.screenshotDataUrl)}" alt="截图" />` : ""}
        <div class="note-meta">时间点 ${escapeHtml(timestamp)}</div>
      </div>`;
  };

  if (chapters.length > 0 && filteredVideoId) {
    chapters.forEach((chapter, chapterIdx) => {
      const chapterStart = Number(chapter.timestampSeconds) || 0;
      const nextChapterStart = chapters[chapterIdx + 1]
        ? Number(chapters[chapterIdx + 1].timestampSeconds) || Infinity
        : Infinity;
      const chapterNotes = sortedNotes.filter((note) => {
        const t = Number(note.timestampSeconds) || 0;
        return t >= chapterStart && t < nextChapterStart;
      });

      let chapterHtml = `
        <div class="chapter">
          <h2 class="chapter-title"><span class="chapter-no">${chapterIdx + 1}</span> ${escapeHtml(chapter.title || `章节 ${chapterIdx + 1}`)}</h2>`;
      if (chapter.summary) {
        chapterHtml += `<div class="chapter-summary">${escapeHtml(chapter.summary)}</div>`;
      }
      if (chapterNotes.length > 0) {
        chapterNotes.forEach((note, noteIdx) => {
          chapterHtml += renderNote(note, `${chapterIdx + 1}.${noteIdx + 1}`);
        });
      } else {
        chapterHtml += `<div class="chapter-empty">本部分暂无笔记</div>`;
      }
      chapterHtml += `</div>`;
      bodySections.push(chapterHtml);
    });

    const preChapterNotes = sortedNotes.filter(
      (note) =>
        (Number(note.timestampSeconds) || 0) <
        (Number(chapters[0]?.timestampSeconds) || 0),
    );
    if (preChapterNotes.length > 0) {
      let preHtml = `<div class="chapter"><h2 class="chapter-title">章节前内容</h2>`;
      preChapterNotes.forEach((note, idx) => {
        preHtml += renderNote(note, `0.${idx + 1}`);
      });
      preHtml += `</div>`;
      bodySections.unshift(preHtml);
    }
  } else if (sortedNotes.length > 0) {
    sortedNotes.forEach((note, idx) => {
      bodySections.push(renderNote(note, idx + 1));
    });
  }

  const bodyHtml =
    bodySections.length > 0
      ? bodySections.join("")
      : `<div class="chapter-empty">还没有保存任何笔记。</div>`;

  const exportDate = exportDateOverride
    ? exportDateOverride
    : new Date().toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(courseTitle)} - 课程笔记</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    color: #1f2430;
    line-height: 1.65;
    margin: 0;
    padding: 24px;
    font-size: 13px;
  }
  .doc-title { font-size: 22px; font-weight: 800; margin: 0 0 4px; }
  .doc-meta { color: #5e6b7a; font-size: 12px; margin-bottom: 20px; }
  .chapter {
    margin: 0 0 20px;
    padding: 0 0 14px;
    border-bottom: 1px solid #dce7f6;
    page-break-inside: auto;
  }
  .chapter-title {
    font-size: 17px;
    font-weight: 800;
    margin: 14px 0 6px;
    padding: 6px 10px;
    background: #eef5ff;
    border-left: 4px solid #00a1d6;
    border-radius: 6px;
  }
  .chapter-no {
    display: inline-block;
    min-width: 22px;
    color: #00a1d6;
  }
  .chapter-summary {
    color: #4a5a6f;
    font-size: 12.5px;
    margin: 4px 0 10px;
    padding-left: 12px;
  }
  .note-block {
    margin: 10px 0 10px 18px;
    padding: 10px 12px;
    border: 1px solid #dce7f6;
    border-radius: 8px;
    background: #fafcff;
    page-break-inside: avoid;
  }
  .note-point-label {
    font-size: 11px;
    font-weight: 800;
    color: #00a1d6;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .note-text { white-space: pre-wrap; }
  .note-ocr {
    margin-top: 8px;
    padding: 8px 10px;
    background: #eef5ff;
    border-radius: 6px;
    font-size: 12px;
  }
  .note-ocr-label {
    font-size: 10.5px;
    font-weight: 800;
    color: #00a1d6;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  .note-img {
    display: block;
    max-width: 72%;
    margin: 8px auto 4px;
    border: 1px solid #dce7f6;
    border-radius: 6px;
  }
  .note-meta {
    margin-top: 6px;
    color: #8b97a6;
    font-size: 11px;
  }
  .chapter-empty { color: #8b97a6; padding-left: 18px; font-size: 12.5px; }
  .doc-footer {
    margin-top: 24px;
    padding-top: 10px;
    border-top: 1px solid #dce7f6;
    color: #8b97a6;
    font-size: 11px;
    text-align: center;
  }
  .print-hint {
    margin: 0 0 16px;
    padding: 10px 14px;
    background: #eaf4ff;
    border: 1px solid #c5dfff;
    border-radius: 8px;
    color: #274261;
    font-size: 13px;
  }
  @media print {
    .print-hint { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <h1 class="doc-title">${escapeHtml(courseTitle)}</h1>
  <div class="doc-meta">课程笔记 · 导出日期 ${escapeHtml(exportDate)}</div>
  ${bodyHtml}
  <div class="doc-footer">由 Bilibili Digest 生成</div>
</body>
</html>`;
}

/**
 * Exports the current notes view as a PDF and downloads it directly.
 * Renders a hidden A4-styled clone of the notes, captures it with
 * html2canvas, slices it into A4 pages, and saves with jsPDF.
 */
async function exportNotesPdf() {
  const exportBtn = document.getElementById("notesExportPdfBtn");
  const originalLabel = exportBtn?.textContent || "⬇ 导出 PDF";
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = "⏳ 生成中…";
  }

  try {
    const isAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    const videoId = isAll ? null : currentVideoId;

    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });
    if (!result?.success) return;

    const notes = result.notes || [];
    const courseTitle = isAll ? "全部笔记" : currentVideoTitle || "当前课程";
    const exportDate = new Date().toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = buildNotesExportHtml(notes, videoId, courseTitle, exportDate);
    await renderHtmlToPdf(html, `${sanitizeFilename(courseTitle)}-笔记.pdf`);
  } catch (error) {
    console.error("[YouTube Digest Panel] Export PDF error:", error);
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = originalLabel;
    }
  }
}

/**
 * Renders a full HTML document in a hidden iframe and prints each page of the
 * content to an A4 PDF using html2canvas + jsPDF, then triggers the download.
 */
function renderHtmlToPdf(html, filename) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "0";
    iframe.style.width = "794px"; // A4 at 96dpi
    iframe.style.height = "1123px";
    iframe.style.border = "none";
    document.body.appendChild(iframe);

    const cleanup = () => {
      setTimeout(() => iframe.remove(), 1000);
    };

    iframe.addEventListener("load", async () => {
      try {
        const doc = iframe.contentDocument;
        const body = doc?.body;
        if (!doc || !body) throw new Error("PDF 渲染失败：无法访问内容");

        // Wait for images and fonts to be ready
        await Promise.all(
          Array.from(doc.images).map(
            (img) =>
              img.complete
                ? Promise.resolve()
                : new Promise((r) => {
                    img.addEventListener("load", r, { once: true });
                    img.addEventListener("error", r, { once: true });
                  }),
          ),
        );
        await new Promise((r) => setTimeout(r, 150));

        const canvas = await html2canvas(body, {
          scale: 2,
          backgroundColor: "#ffffff",
          logging: false,
          useCORS: true,
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 10;
        const contentWidth = pageWidth - margin * 2;
        const contentHeight = pageHeight - margin * 2;

        const imgWidth = contentWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        const imgData = canvas.toDataURL("image/jpeg", 0.92);
        let heightLeft = imgHeight;
        let position = margin;

        pdf.addImage(imgData, "JPEG", margin, position, imgWidth, imgHeight);
        heightLeft -= contentHeight;

        while (heightLeft > 0) {
          pdf.addPage();
          position = margin - (imgHeight - heightLeft);
          pdf.addImage(imgData, "JPEG", margin, position, imgWidth, imgHeight);
          heightLeft -= contentHeight;
        }

        pdf.save(filename);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        cleanup();
      }
    });

    iframe.srcdoc = html;
  });
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + Chinese`
      : `Chinese · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "重试中…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  normalizeCaptionText,
  normalizeTranscriptEntries,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
};
