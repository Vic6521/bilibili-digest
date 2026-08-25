/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  taskName = "analysis",
  modelOverride,
}) {
  const settings = await getSettings();
  const routedModel = YTD_SETTINGS.getModelConfig(taskName, modelOverride || {});
  const provider = routedModel.provider;

  if (provider !== "deepseek" && provider !== "qwen") {
    const error = new Error(`Unsupported provider: ${provider}`);
    error.code = "UNSUPPORTED_PROVIDER";
    throw error;
  }

  const apiKey = YTD_SETTINGS.getProviderApiKey(settings, provider);
  if (!apiKey) {
    const providerLabel = provider === "qwen" ? "Qwen" : "DeepSeek";
    const error = new Error(
      `${providerLabel} API key not configured. Open Settings.`,
    );
    error.code = provider === "qwen" ? "NO_QWEN_KEY" : "NO_AI_KEY";
    throw error;
  }

  const apiUrl = YTD_SETTINGS.getProviderEndpoint(provider);
  const providerLabel = provider === "qwen" ? "Qwen" : "DeepSeek";

  const body = {
    model: routedModel.model,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  if (provider === "deepseek") {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Receiving headers proves the provider is still making progress.
    // Some providers send blank-line body chunks while a non-streaming
    // request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout, providerLabel);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `${providerLabel} error: ${response.status}`,
      );
      error.status = response.status;
      error.provider = provider;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error(`${providerLabel} returned an empty response.`);
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings, provider };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        `${providerLabel} request was inactive for 50 seconds. Please Retry.`,
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        `${providerLabel} request exceeded the 120-second limit. Please Retry.`,
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity, providerLabel = "DeepSeek") {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

/**
 * Sends an image (screenshot) plus optional text prompt to the Qwen
 * vision model for understanding. Uses the OpenAI-compatible chat
 * completions format with image_url content.
 *
 * @param {Object} options
 * @param {string} options.imageDataUrl - data:image/png;base64,... screenshot
 * @param {string} options.prompt - text instruction for the model
 * @param {number} [options.maxTokens] - max output tokens (default 1024)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function requestQwenVisionCompletion({
  imageDataUrl,
  prompt,
  maxTokens = 1024,
}) {
  try {
    const settings = await getSettings();
    const routedModel = YTD_SETTINGS.getModelConfig("screenshotSummary");
    const apiKey = YTD_SETTINGS.getProviderApiKey(settings, routedModel.provider);

    if (routedModel.provider !== "qwen" || !apiKey) {
      return {
        success: false,
        error: "Qwen API key not configured. Open Settings.",
        code: "NO_QWEN_KEY",
      };
    }

    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      return {
        success: false,
        error: "No screenshot provided.",
        code: "NO_IMAGE",
      };
    }

    const apiUrl = YTD_SETTINGS.getProviderEndpoint("qwen");
    const body = {
      model: routedModel.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt || "Describe what is shown in this image." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    };

    const controller = new AbortController();
    let timeoutKind = "";
    let idleTimeoutId;
    let hardTimeoutId;
    const abortForTimeout = (kind) => {
      if (controller.signal.aborted) return;
      timeoutKind = kind;
      controller.abort();
    };
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(
        () => abortForTimeout("idle"),
        AI_PROVIDER_IDLE_TIMEOUT_MS,
      );
    };

    hardTimeoutId = setTimeout(
      () => abortForTimeout("hard"),
      AI_PROVIDER_HARD_TIMEOUT_MS,
    );
    resetIdleTimeout();

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      resetIdleTimeout();

      const data = await readBoundedAiResponse(response, resetIdleTimeout, "Qwen");
      if (!response.ok) {
        const errorData = data && typeof data === "object" ? data : {};
        const error = new Error(
          errorData.error?.message ||
            errorData.message ||
            `Qwen error: ${response.status}`,
        );
        error.status = response.status;
        return { success: false, error: error.message, code: "QWEN_ERROR" };
      }

      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        return {
          success: false,
          error: "Qwen returned an empty response.",
          code: "EMPTY_AI_RESPONSE",
        };
      }

      return { success: true, text: text.trim() };
    } catch (error) {
      if (timeoutKind === "idle") {
        return {
          success: false,
          error: "Qwen request was inactive for 50 seconds. Please Retry.",
          code: "AI_IDLE_TIMEOUT",
        };
      }
      if (timeoutKind === "hard") {
        return {
          success: false,
          error: "Qwen request exceeded the 120-second limit. Please Retry.",
          code: "AI_HARD_TIMEOUT",
        };
      }
      return { success: false, error: error.message, code: error.code || "QWEN_ERROR" };
    } finally {
      clearTimeout(idleTimeoutId);
      clearTimeout(hardTimeoutId);
    }
  } catch (error) {
    return { success: false, error: error.message, code: "QWEN_ERROR" };
  }
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function isSupportedVideoTabUrl(url) {
  try {
    const parsed = new URL(url || "");
    const isYouTube =
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "youtu.be";
    const isBilibili = parsed.hostname.endsWith("bilibili.com");

    return (
      (isYouTube &&
        (parsed.hostname === "youtu.be" ||
          parsed.searchParams.has("v") ||
          parsed.pathname.startsWith("/watch"))) ||
      (isBilibili && parsed.pathname.startsWith("/video/"))
    );
  } catch {
    return false;
  }
}

async function findSupportedVideoTab() {
  const queries = [
    { url: "https://www.youtube.com/*", active: true },
    { url: "https://www.bilibili.com/video/*", active: true },
    { url: "https://www.youtube.com/*" },
    { url: "https://www.bilibili.com/video/*" },
  ];

  for (const query of queries) {
    const tabs = await chrome.tabs.query(query);
    if (tabs[0] && isSupportedVideoTabUrl(tabs[0].url)) return tabs[0];
  }

  return null;
}

function updatePanelForTab(tabId, url) {
  const isSupported = isSupportedVideoTabUrl(url);
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isSupported })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscriptWithFallback(message.videoId, message.videoUrl, sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "fetchBilibiliSubtitleJson") {
    (async () => {
      try {
        const resp = await fetch(message.url, { credentials: "include" });
        if (!resp.ok) {
          sendResponse({ success: false, error: `HTTP ${resp.status}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "summarizeScreenshot") {
    handleSummarizeScreenshot(message.screenshotDataUrl, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.screenshotDataUrl,
      sender.tab?.id,
      message.sourcePlatform,
      message.videoUrl,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "ocrScreenshot") {
    // Extract text from a note screenshot using the Qwen vision model.
    handleOcrScreenshot(message.screenshotDataUrl, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "updateNoteText") {
    // Persist OCR (or edited) text back onto a saved note.
    handleUpdateNoteText(message.noteId, message.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "addNote") {
    // Create a note directly from user-typed text at a chapter timestamp.
    handleAddNote({
      videoId: message.videoId,
      timestamp: message.timestamp,
      videoTitle: message.videoTitle,
      channelName: message.channelName,
      sourcePlatform: message.sourcePlatform,
      videoUrl: message.videoUrl,
      text: message.text,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
          hasQwenKey: !!settings.qwenApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no supported tab found, try broader queries
        if (!tabs[0] || !isSupportedVideoTabUrl(tabs[0].url)) {
          tabs = await chrome.tabs.query({
            url: ["https://www.youtube.com/*", "https://www.bilibili.com/video/*"],
            active: true,
          });
          debugLog("[YouTube Digest BG] Active supported tabs:", tabs.length);
        }

        // Still nothing? Try any supported tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({
            url: ["https://www.youtube.com/*", "https://www.bilibili.com/video/*"],
          });
          debugLog("[YouTube Digest BG] Any supported tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
function normalizeTranscriptLines(transcript = []) {
  const lines = [];
  for (const chunk of transcript) {
    const text = String(chunk?.text || "").replace(/>> ?/g, "").trim();
    if (!text) continue;
    const startSeconds = Math.max(0, Math.floor(Number(chunk?.start) || 0));
    const duration = Math.max(0, Math.floor(Number(chunk?.duration) || 0));
    lines.push({
      text,
      start: startSeconds,
      duration,
      end: startSeconds + duration,
      language: chunk?.language || null,
    });
  }
  return lines;
}

function formatTranscriptText(lines) {
  let plain = "";
  let timestamped = "";
  for (const line of lines) {
    const minutes = Math.floor(line.start / 60);
    const seconds = line.start % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    plain += `${line.text} `;
    timestamped += `[${timestamp}] ${line.text}\n`;
  }
  return {
    transcriptText: plain.trim(),
    transcriptTextTimestamped: timestamped.trim(),
  };
}

function buildTranscriptPayload(data) {
  const transcript = normalizeTranscriptLines(data?.content || []);
  const formatted = formatTranscriptText(transcript);
  return {
    transcript,
    ...formatted,
    language: typeof data?.lang === "string" ? data.lang : null,
  };
}

/**
 * Tries Bilibili's native subtitle API first (if on a Bilibili page),
 * then falls back to Supadata. For YouTube, goes straight to Supadata.
 */
async function handleFetchTranscriptWithFallback(videoId, videoUrl, tabId) {
  const isBilibili = videoUrl && videoUrl.includes("bilibili.com");

  if (isBilibili) {
    try {
      const supportedTab = tabId ? { id: tabId } : await findSupportedVideoTab();
      const resolvedTabId = supportedTab?.id;

      if (!resolvedTabId) {
        return {
          success: false,
          error: "NO_BILIBILI_TAB",
          message: "找不到当前 B 站视频标签页，请刷新页面后重试。",
          fallbackMode: "screenshot",
        };
      }

      debugLog("[YouTube Digest] Trying Bilibili native subtitles...");
      const biliResult = await chrome.tabs.sendMessage(resolvedTabId, {
        action: "getBilibiliSubtitle",
      });

      if (biliResult?.success && biliResult?.transcript?.length > 0) {
        debugLog("[YouTube Digest] Bilibili subtitles found:", biliResult.transcript.length, "segments");
        const formatted = formatTranscriptText(biliResult.transcript);
        return {
          success: true,
          transcript: biliResult.transcript,
          transcriptText: formatted.transcriptText,
          transcriptTextTimestamped: formatted.transcriptTextTimestamped,
          language: biliResult.language || "zh",
          source: "bilibili_native",
        };
      }

      debugLog("[YouTube Digest] Bilibili native subtitles unavailable:", biliResult?.error);

      return {
        success: false,
        error: biliResult?.error || "NO_BILIBILI_SUBTITLE",
        message:
          biliResult?.error ||
          "该视频没有可用的字幕轨道。你可以尝试使用截图笔记功能，点击字幕行旁的相机按钮保存关键帧。",
        fallbackMode: "screenshot",
      };
    } catch (err) {
      debugLog("[YouTube Digest] Bilibili subtitle fetch failed:", err.message);

      return {
        success: false,
        error: "BILIBILI_SUBTITLE_ERROR",
        message: "无法获取B站字幕，可能需要刷新页面或重新加载扩展。",
        fallbackMode: "screenshot",
      };
    }
  }

  debugLog("[YouTube Digest] Falling back to Supadata...");
  return handleFetchTranscript(videoId, videoUrl);
}

async function handleFetchTranscript(videoId, videoUrl = "") {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = videoUrl || YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "zh"); // Prefer Chinese for Bilibili and learning videos
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();
    const payload = buildTranscriptPayload(data);
    const transcript = payload.transcript;

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: payload.transcriptText,
      transcriptTextTimestamped: payload.transcriptTextTimestamped,
      language: payload.language,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      const payload = buildTranscriptPayload(data);

      return {
        success: true,
        transcript: payload.transcript,
        transcriptText: payload.transcriptText,
        transcriptTextTimestamped: payload.transcriptTextTimestamped,
        language: payload.language,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      taskName: "analysis",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
function buildNote({
  platform,
  videoId,
  timestamp,
  timestampSeconds,
  captionText,
  videoTitle,
  channelName,
  videoUrl,
  screenshotDataUrl,
  text,
  ocrText,
}) {
  const safeTimestampSeconds = Math.max(0, Math.floor(Number(timestampSeconds) || 0));
  const minutes = Math.floor(safeTimestampSeconds / 60);
  const seconds = safeTimestampSeconds % 60;
  const formattedTimestamp =
    typeof timestamp === "string" && timestamp.trim()
      ? timestamp.trim()
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return {
    id: `note_${Date.now()}`,
    sourcePlatform: platform || "youtube",
    videoId,
    videoTitle:
      typeof videoTitle === "string" ? videoTitle.slice(0, 500) : "Untitled Video",
    channelName:
      typeof channelName === "string" ? channelName.slice(0, 300) : "",
    videoUrl: typeof videoUrl === "string" ? videoUrl : "",
    timestamp: formattedTimestamp,
    timestampSeconds: safeTimestampSeconds,
    captionText: typeof captionText === "string" ? captionText.slice(0, 3000) : "",
    screenshotDataUrl: typeof screenshotDataUrl === "string" ? screenshotDataUrl : "",
    ocrText: typeof ocrText === "string" ? ocrText.slice(0, 3000) : "",
    text: typeof text === "string" ? text.slice(0, 3000) : "",
    rawText: typeof captionText === "string" ? captionText : "",
    createdAt: Date.now(),
  };
}

async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  screenshotDataUrl = null,
  tabId = null,
  sourcePlatform = "youtube",
  videoUrl = "",
) {
  try {
    const isBilibili = sourcePlatform === "bilibili" || /^BV/i.test(videoId || "");
    const canonicalVideoUrl = isBilibili
      ? (videoUrl || `https://www.bilibili.com/video/${videoId}`)
      : YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      if (isBilibili) {
        if (!tabId) {
          return { success: false, error: "No active Bilibili tab found" };
        }
        // For Bilibili, ask the content script on the exact current tab.
        try {
          const biliResult = await chrome.tabs.sendMessage(tabId, {
            action: "getBilibiliSubtitle",
          });
          if (biliResult?.success && biliResult?.transcript?.length > 0) {
            transcript = biliResult.transcript;
          } else {
            return { success: false, error: biliResult?.error || "No Bilibili transcript available" };
          }
        } catch (err) {
          return { success: false, error: `Bilibili subtitle fetch failed: ${err.message}` };
        }
      } else {
        const transcriptResult = await handleFetchTranscript(videoId);
        if (!transcriptResult.success) {
          return { success: false, error: "Could not fetch transcript" };
        }
        transcript = transcriptResult.transcript;
      }
    }

    // Find the transcript line at the current timestamp. Subtitle lookup is
    // best-effort: a note must still be saved when Bilibili has no ready AI track.
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    const fallbackText = matchedLine?.text || "截图笔记";
    let cleanedText = fallbackText;
    try {
      if (matchedLine) {
        cleanedText = await cleanupNoteText(
          matchedLine.text,
          beforeLine,
          afterLine,
          contextLines.join(" "),
          videoTitle,
        );
      }
    } catch (error) {
      console.warn("[YouTube Digest] Note text cleanup failed; saving raw text:", error.message);
    }

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = isBilibili
      ? `${canonicalVideoUrl}?t=${safeTimestamp}`
      : `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = buildNote({
      platform: sourcePlatform,
      videoId,
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      captionText: matchedLine?.text || "",
      videoTitle,
      channelName,
      videoUrl: videoUrl || canonicalVideoUrl,
      screenshotDataUrl,
      text: cleanedText,
    });
    note.timestampedUrl = timestampedUrl;

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    // Best-effort OCR: extract the text visible in the screenshot and attach
    // it to the note. Never blocks or fails the note save itself.
    if (screenshotDataUrl) {
      try {
        const ocrResult = await handleOcrScreenshot(screenshotDataUrl, videoTitle);
        if (ocrResult.success && ocrResult.text) {
          const updated = await handleUpdateNoteText(note.id, ocrResult.text);
          if (updated.success) {
            chrome.runtime
              .sendMessage({ action: "noteSaved", note: updated.note })
              .catch(() => {});
          }
        }
      } catch (ocrError) {
        console.warn("[YouTube Digest] Screenshot OCR failed; note kept as-is:", ocrError.message);
      }
    }

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      taskName: "noteCleanup",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  const deduped = notes.filter(
    (existing) =>
      !(
        existing.videoId === note.videoId &&
        Number(existing.timestampSeconds) === Number(note.timestampSeconds) &&
        existing.captionText === note.captionText &&
        existing.sourcePlatform === note.sourcePlatform
      ),
  );
  deduped.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (deduped.length > 100) {
    deduped.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: deduped });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    // Always return notes sorted from newest to oldest so refreshes feel immediate.
    notes = [...notes].sort((a, b) => (b.timestampSeconds || 0) - (a.timestampSeconds || 0));

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      taskName: "explanation",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      taskName: "translation",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Uses a vision-capable model (Qwen by default) to summarize the content of a
 * video screenshot — useful for reading board work, slides, or diagrams that
 * the text transcript cannot convey.
 */
async function handleSummarizeScreenshot(screenshotDataUrl, videoTitle) {
  try {
    const settings = await getSettings();
    const apiKey = YTD_SETTINGS.getProviderApiKey(settings, "qwen");
    if (!apiKey) {
      return {
        success: false,
        error: "NO_QWEN_KEY",
        message: "Qwen API key not configured. Open Settings to add one.",
      };
    }

    const { text: summary } = await requestAiCompletion({
      maxTokens: 1024,
      taskName: "screenshotSummary",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `这是一个课程视频的截图（标题：${videoTitle || "未知"}）。请用中文简要描述截图中的内容，重点关注板书、课件、公式或图表信息。`,
            },
            {
              type: "image_url",
              image_url: { url: screenshotDataUrl },
            },
          ],
        },
      ],
    });

    return { success: true, summary: summary.trim() };
  } catch (error) {
    console.error("[YouTube Digest] Screenshot summary error:", error);
    return {
      success: false,
      error: error.code || error.message || "Failed to summarize screenshot",
    };
  }
}

/**
 * Cleans up OCR output before it is stored: strips Markdown code fences,
 * model preamble lines, and double-escaped LaTeX braces so the notes page
 * shows clean board notes instead of raw "code" blocks.
 */
/**
 * Converts common LaTeX commands into readable Unicode symbols so the stored
 * OCR text reads like board notes instead of raw code.
 */
function latexToUnicode(value) {
  let text = String(value || "");

  // Strip explicit display/inline math markers and \displaystyle.
  text = text.replace(/\$\$/g, "").replace(/\$/g, "");
  text = text.replace(/\\displaystyle\s*/g, "").replace(/\\limits\s*/g, "");

  // Keep content inside common formatting wrappers.
  text = text.replace(/\\(?:text|mathrm|textbf|textit|operatorname)\{([^{}]*)\}/g, "$1");

  // Convert common vector / accent commands into plain readable forms.
  text = text.replace(/\\vec\{([^{}]*)\}/g, "→$1");
  text = text.replace(/\\overrightarrow\{([^{}]*)\}/g, "→$1");
  text = text.replace(/\\overline\{([^{}]*)\}/g, "$1̄");
  text = text.replace(/\\underline\{([^{}]*)\}/g, "$1");

  // Fractions and roots.
  text = text.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, num, den) => `(${num})/(${den})`);
  text = text.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");

  // Limits and common operators.
  text = text.replace(/\\lim_?\{?([^{}\n]*)\}?/g, (_, sub) =>
    sub ? `lim(${sub.replace(/\\to/g, "→").replace(/\\infty/g, "∞")})` : "lim",
  );
  text = text.replace(/\\sum_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "Σ");
  text = text.replace(/\\prod_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "∏");
  text = text.replace(/\\int_?\{?[^{}]*\}?(?:\^\{?[^{}]*\}?)?/g, "∫");

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

  const symbols = {
    "\\to": "→", "\\rightarrow": "→", "\\Rightarrow": "⇒", "\\Longrightarrow": "⟹",
    "\\leftarrow": "←", "\\Leftarrow": "⇐", "\\Leftrightarrow": "⇔", "\\iff": "⇔",
    "\\leq": "≤", "\\leqslant": "≤", "\\le": "≤", "\\geq": "≥", "\\geqslant": "≥",
    "\\ge": "≥", "\\neq": "≠", "\\ne": "≠", "\\approx": "≈", "\\sim": "∼",
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

  // Normalize powers and subscripts.
  text = text.replace(/\^\{([^{}]*)\}/g, "^$1");
  text = text.replace(/_\{([^{}]*)\}/g, "_$1");

  // Drop layout-only commands.
  text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "");
  text = text.replace(/\\(?:quad|qquad|;|,|!|:|space|hspace\{[^{}]*\})/g, " ");

  // Convert cases / align-ish blocks to plain lines.
  text = text.replace(/\\begin\{cases\}/g, "{");
  text = text.replace(/\\end\{cases\}/g, "}");
  text = text.replace(/\\begin\{[^{}]*\}/g, "");
  text = text.replace(/\\end\{[^{}]*\}/g, "");
  text = text.replace(/\\\\/g, "\n");

  // Escaped braces / pipes / parens become their plain characters.
  text = text.replace(/\\\{/g, "{").replace(/\\\}/g, "}");
  text = text.replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")");

  // Unknown commands: keep any braced argument, drop the command word itself
  // so \hat{n}, \boldsymbol{x}, \textstyle etc. never leak into the notes.
  text = text.replace(/\\[a-zA-Z]+\*?\s*\{([^{}]*)\}/g, "$1");
  text = text.replace(/\\[a-zA-Z]+\*/g, "");
  text = text.replace(/\\[a-zA-Z]+/g, "");

  // Collapse spacing noise.
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  // Tidy punctuation spacing.
  text = text.replace(/\s+([,，。:：;；!?！？])/g, "$1");
  text = text.replace(/([（(\[{])\s+/g, "$1");
  text = text.replace(/\s+([）)\]}])/g, "$1");

  return text.trim();
}

function normalizeOcrOutput(rawText) {
  let text = String(rawText || "");

  // Drop Markdown code fences (```) and their language hints.
  text = text.replace(/```[a-zA-Z]*/g, "").replace(/```/g, "");

  // Drop common model preamble lines like "截图中的文字内容如下：".
  text = text.replace(/^\s*(截图中的文字内容如下[:：]?|以下是识别结果[:：]?|识别结果[:：]?)\s*/g, "");

  // Normalize double-escaped braces inside LaTeX: ${{x}}$ -> $x$, {{...}} -> {...}
  text = text.replace(/\{\{([^{}]*)\}\}/g, "{$1}");

  // Convert LaTeX commands to readable Unicode symbols.
  text = latexToUnicode(text);

  // Collapse 3+ consecutive blank lines.
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Extracts text from a note screenshot using the Qwen vision model. This is
 * the "read the board" flow: when a note only captured an image, we still get
 * its text content written into the note.
 */
async function handleOcrScreenshot(screenshotDataUrl, videoTitle) {
  try {
    const settings = await getSettings();
    const apiKey = YTD_SETTINGS.getProviderApiKey(settings, "qwen");
    if (!apiKey) {
      return {
        success: false,
        error: "NO_QWEN_KEY",
        message: "未配置 Qwen API Key，请先到设置中填写。",
      };
    }

    const { text } = await requestAiCompletion({
      maxTokens: 1536,
      taskName: "screenshotSummary",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `这是一张课程视频的板书截图（视频标题：${videoTitle || "未知"}）。请像整理板书笔记一样，直接输出图中的内容，要求：\n1. 严格按图中顺序和分层提取，保留标题、分点、公式、说明和例题的原始结构。\n2. 不要输出代码块、反引号、Markdown 标记或任何多余包装。\n3. 数学符号优先使用直观的可读记号，例如：∈、⊂、⊆、∞、→、≤、≥、≠、±、∫、∑、π、α、β、Δ；分数写成 a/b；上下标写成 x^2、a_n。\n4. 如果出现向量、法向量、方向、导数等内容，请保留清晰的数学表达，不要写成代码命令（例如不要保留 \\vec、\\frac、\\begin、\\end 这类命令）。\n5. 向量请写成 n⃗、n₀⃗ 或直接写 n；不要输出 \\vec{n}、\\overrightarrow{AB} 等命令。分数直接写 a/b，不要输出 \\frac。\n6. 如果是分段函数、极限、积分或多行推导，请整理成清晰的分行文本，而不是代码格式。\n7. 如果截图中没有可识别的文字，请直接输出“截图中没有可识别的文字”。\n8. 不要添加任何解释、说明、前言或结尾，只输出识别出的原文。`,
            },
            {
              type: "image_url",
              image_url: { url: screenshotDataUrl },
            },
          ],
        },
      ],
    });

    const recognized = normalizeOcrOutput(String(text || "").trim());
    return recognized
      ? { success: true, text: recognized }
      : { success: false, error: "EMPTY_OCR", message: "未识别到文字内容。" };
  } catch (error) {
    console.error("[YouTube Digest] Screenshot OCR error:", error);
    return {
      success: false,
      error: error.code || error.message || "Failed to extract text from screenshot",
    };
  }
}

/**
 * Overwrites the text of a saved note (used to store OCR results) while
 * preserving everything else about the note.
 */
async function handleUpdateNoteText(noteId, text) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  const index = notes.findIndex((note) => note.id === noteId);
  if (index === -1) {
    return { success: false, error: "Note not found" };
  }

  const safeText = String(text || "").slice(0, 3000);
  notes[index].text = safeText;
  if (!notes[index].ocrText) {
    notes[index].ocrText = safeText;
  }
  notes[index].updatedAt = Date.now();

  await chrome.storage.local.set({ ytd_notes: notes });
  return { success: true, note: notes[index] };
}

/**
 * Creates a note from text the user typed directly in the notes panel.
 * Used by the per-chapter "add knowledge point" editor so the outline is
 * populated without requiring a video screenshot or transcript lookup.
 */
async function handleAddNote({
  videoId,
  timestamp = 0,
  videoTitle,
  channelName,
  sourcePlatform = "bilibili",
  videoUrl,
  text,
}) {
  try {
    const safeTimestampSeconds = Math.max(
      0,
      Math.floor(Number(timestamp) || 0),
    );
    const safeText = String(text || "").trim().slice(0, 3000);
    if (!safeText) {
      return { success: false, error: "内容为空" };
    }
    if (!videoId) {
      return { success: false, error: "缺少视频 ID" };
    }

    const note = buildNote({
      platform: sourcePlatform,
      videoId,
      timestampSeconds: safeTimestampSeconds,
      videoTitle,
      channelName,
      videoUrl,
      text: safeText,
      captionText: "",
      ocrText: "",
      screenshotDataUrl: "",
    });
    note.timestampedUrl = (videoUrl || `https://www.bilibili.com/video/${videoId}`) + `?t=${safeTimestampSeconds}`;

    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Add note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Builds an overview payload from validated analysis results. Used as a pure
 * transform layer between the model's JSON and the side panel's rendering.
 */
function buildOverview(segments) {
  if (!Array.isArray(segments)) return { sections: [] };
  return {
    sections: segments.map((seg, i) => ({
      title: seg.title || `第 ${i + 1} 段`,
      summary: seg.summary || "",
      timestamp: seg.timestamp || "",
      timestampSeconds: seg.timestampSeconds || 0,
    })),
  };
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};

globalThis.__YTD_MODEL_TESTING__ = {
  selectModel: YTD_SETTINGS.selectModel,
  getModelConfig: YTD_SETTINGS.getModelConfig,
  getProviderEndpoint: YTD_SETTINGS.getProviderEndpoint,
  getProviderApiKey: YTD_SETTINGS.getProviderApiKey,
  buildOverview,
};

globalThis.__BILI_OVERVIEW_TESTING__ = {
  buildOverview,
};

globalThis.__BILI_NOTE_TESTING__ = {
  buildNote,
};

globalThis.__YTD_MODEL_TESTING__ = {
  requestAiCompletion,
  requestQwenVisionCompletion,
  selectModel: YTD_SETTINGS.selectModel,
  getModelConfig: YTD_SETTINGS.getModelConfig,
  getProviderEndpoint: YTD_SETTINGS.getProviderEndpoint,
  getProviderApiKey: YTD_SETTINGS.getProviderApiKey,
  TASK_MODELS: YTD_SETTINGS.TASK_MODELS,
};
