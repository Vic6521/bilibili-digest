/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
    qwenApiKey: "",
    qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    qwenModel: "qwen-vl-plus",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
      qwenApiKey:
        typeof input.qwenApiKey === "string"
          ? input.qwenApiKey.trim()
          : "",
      qwenBaseUrl: DEFAULTS.qwenBaseUrl,
      qwenModel: DEFAULTS.qwenModel,
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl() {
    return `${DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function qwenChatCompletionsUrl() {
    return `${DEFAULTS.qwenBaseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  // ============================================================
  // MODEL ROUTING
  // ============================================================

  const TASK_MODELS = Object.freeze({
    // Text-only tasks: use DeepSeek by default
    overview: { provider: "deepseek", model: "deepseek-v4-flash" },
    keynotes: { provider: "deepseek", model: "deepseek-v4-flash" },
    chapters: { provider: "deepseek", model: "deepseek-v4-flash" },
    keyQuotes: { provider: "deepseek", model: "deepseek-v4-flash" },
    analysis: { provider: "deepseek", model: "deepseek-v4-flash" },
    explanation: { provider: "deepseek", model: "deepseek-v4-flash" },
    noteCleanup: { provider: "deepseek", model: "deepseek-v4-flash" },
    translation: { provider: "deepseek", model: "deepseek-v4-flash" },

    // Vision-aware tasks: use Qwen by default
    screenshotSummary: { provider: "qwen", model: "qwen-vl-plus" },
    imageExplanation: { provider: "qwen", model: "qwen-vl-plus" },
    visualKeypoints: { provider: "qwen", model: "qwen-vl-plus" },
  });

  function selectModel(taskName) {
    const mapped = TASK_MODELS[taskName];
    if (mapped) return mapped;
    // Default to DeepSeek for unknown text tasks
    return { provider: "deepseek", model: "deepseek-v4-flash" };
  }

  function getModelConfig(taskName, overrides = {}) {
    const model = selectModel(taskName);
    return {
      provider: overrides.provider || model.provider,
      model: overrides.model || model.model,
    };
  }

  function getProviderEndpoint(provider) {
    if (provider === "qwen") {
      return qwenChatCompletionsUrl();
    }
    return chatCompletionsUrl();
  }

  function getProviderApiKey(settings, provider) {
    if (provider === "qwen") {
      return settings.qwenApiKey || "";
    }
    return settings.aiApiKey || "";
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    qwenChatCompletionsUrl,
    canonicalYouTubeUrl,
    selectModel,
    getModelConfig,
    getProviderEndpoint,
    getProviderApiKey,
    TASK_MODELS,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
