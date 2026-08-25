# Bilibili Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn Bilibili and YouTube videos into learning resources. Bilibili Digest brings transcripts, bilingual translation, AI overviews, explanations, and timestamped notes into one Chrome side panel, so you can study courses and talks without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save timestamped notes with captions and screenshots, then export them to PDF.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

Bilibili Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/bilibili-digest` on macOS or Linux, or `%USERPROFILE%\Documents\bilibili-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/Vic6521/bilibili-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/bilibili-digest` on macOS or Linux, or `%USERPROFILE%\Documents\bilibili-digest` on Windows.
2. Open the official DeepSeek, Supadata, and Qwen pages below and help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a Bilibili or YouTube video and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the Bilibili Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/Vic6521/bilibili-digest](https://github.com/Vic6521/bilibili-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/bilibili-digest` on macOS or Linux, or `%USERPROFILE%\Documents\bilibili-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin Bilibili Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the Bilibili Digest card at `chrome://extensions`, then refresh open video tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

Bilibili Digest is a bring-your-own-key extension. Which keys you need depends on the platforms and features you use:

1. A **DeepSeek API key** for overviews, explanations, translation, and automatic note polishing on both platforms.
2. A **Supadata API key** to retrieve YouTube transcripts. Supadata is also used as a fallback when a Bilibili video has no native subtitle track.
3. A **Qwen (DashScope) API key** for screenshot-aware AI features, such as summarizing a saved screenshot or explaining the current video frame.

Bilibili videos use Bilibili's native subtitle API first, so Bilibili transcript viewing does not require Supadata. YouTube transcripts always require Supadata.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `Bilibili Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in Bilibili Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in Bilibili Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get a Qwen API key

1. Open the [DashScope API key management page](https://bailian.console.aliyun.com/) or the DashScope console for your account.
2. Sign in or create an Alibaba Cloud account when prompted.
3. Create a DashScope API key with billing enabled.
4. Copy the key and paste it into **Qwen API key** in Bilibili Digest Settings.

Screenshot-aware features such as screenshot summaries and frame explanations use `qwen-vl-plus` through the DashScope compatible mode. Without a Qwen key, the rest of the extension keeps working; only the vision tasks are unavailable.

Open **Settings** from the side panel. You can also open the Bilibili Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version routes text AI tasks to DeepSeek V4 Flash and screenshot-aware tasks to Qwen VL Plus:

```text
DeepSeek text model
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash

Qwen vision model
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen-vl-plus
```

Bilibili Digest sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. The endpoints and models are fixed in Settings, so the only AI credentials you enter are your DeepSeek and Qwen API keys. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use Bilibili Digest

1. Open a standard Bilibili video page (`bilibili.com/video/...`) or a YouTube watch page (`youtube.com/watch?...`).
2. Click the Bilibili Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **原文**, **中文**, or **双语**.
4. Open **总览** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **笔记**. On a video page, click the **📝 笔记** button near the player, or press `n` while the video is focused, to save a timestamped note with a screenshot.
7. Export your notes to PDF from the **笔记** tab when you want a printable study sheet.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard Bilibili `bilibili.com/video` pages and `youtube.com/watch` video pages.
- Bilibili native subtitle tracks fetched directly from Bilibili's subtitle API, with Supadata as the fallback.
- Native subtitle tracks returned by Supadata for YouTube. Bilibili Digest prefers Chinese when available, but may show another available native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing.
- Timestamped notes with captions and screenshots, plus PDF export.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash for all text AI features and Qwen VL Plus for screenshot-aware features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

For YouTube transcripts, Bilibili Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. Bilibili Digest does not use this path for YouTube because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior for YouTube, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek and Qwen usage are separate from Supadata. DeepSeek and Qwen may apply their own free quotas, rate limits, or charges. Bilibili Digest does not collect payments or resell access. Set spending limits and monitor both accounts. The estimate below explains the current DeepSeek translation cost.

## DeepSeek V4 Flash translation cost estimate

Current as of August 10, 2026, DeepSeek lists the following prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

- Cache-hit input: **$0.0028 USD**.
- Cache-miss input: **$0.14 USD**.
- Output: **$0.28 USD**.

DeepSeek says these prices may increase soon, so check the current pricing page before relying on this estimate. Its official [token usage guide](https://api-docs.deepseek.com/quick_start/token_usage/) estimates about 0.3 token per English character and about 0.6 token per Chinese character. Its [context caching guide](https://api-docs.deepseek.com/guides/kv_cache/) explains the automatic best-effort disk cache used for repeated prefixes.

A measured 20-minute English talk contained **2,935 spoken English words** and 15,433 transcript characters. With Bilibili Digest's current grouping, it became 128 semantic segments and 43 requests of three segments each. Repeated prompts and JSON brought the rendered input to about 108,528 English characters, or **about 32,600 input tokens** using DeepSeek's 0.3 token per English character heuristic. The translated Chinese JSON output is estimated at about 3,500 to 4,500 tokens using the 0.6 token per Chinese character heuristic, plus JSON and ID overhead.

If all input is billed as cache miss, input costs about $0.0046 and output costs about $0.0010 to $0.0013, for a total of about $0.0056 to $0.0059. When much of the repeated system prompt hits DeepSeek's automatic best-effort cache, a realistic lower end is about $0.002 to $0.003. A practical estimate for fully translating this talk is therefore **$0.002 to $0.006 USD, about ¥0.02 to ¥0.04**.

Translation is lazy and progressive. Cached segments are reused, and only rows you request by scrolling into them incur calls. Retries, provider behavior, and pricing changes can increase the final cost.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

Bilibili Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact Bilibili Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open Bilibili Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

Bilibili Digest makes provider requests directly from the extension:

1. On a Bilibili video, it requests the subtitle JSON from Bilibili's subtitle API for that video.
2. It sends a canonical YouTube watch URL to Supadata when you view a YouTube transcript, and to Supadata as a fallback when a Bilibili video has no native subtitles.
3. It sends the transcript and relevant video metadata to DeepSeek when you request text AI features, and screenshot or frame content to Qwen for vision features.
4. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
5. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no Bilibili Digest account system, advertising, analytics, or telemetry. Supadata, DeepSeek, Qwen, and Bilibili still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### Bilibili transcript is not found

- Confirm the video is public and has a subtitle track. Some Bilibili videos have no captions.
- If a video has no native subtitles, Bilibili Digest falls back to Supadata. Confirm your Supadata key, remaining credits, and rate limit if the fallback path is expected to work.
- At `chrome://extensions`, find Bilibili Digest and click **Reload**, then refresh the Bilibili tab.
- Ask your coding agent to inspect the content script on that exact video page if the problem continues.

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find Bilibili Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard Bilibili video page or `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm Bilibili Digest is enabled and click **Reload**.
- Refresh the video tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### Bilibili Digest asks for setup

- Open **Settings** and save a DeepSeek key for text AI features. Add a Supadata key for YouTube transcripts and a Qwen key for screenshot features.
- This published version uses the fixed DeepSeek V4 Flash and Qwen VL Plus endpoints and models. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has captions available.
- Check your Supadata key, remaining credits, rate limit, and account status when the transcript request goes through Supadata.
- Remember that unavailable native lookups and manual retries may still consume credits.

Bilibili Digest will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually means the DeepSeek or Qwen key or account access is invalid.
- A `429` usually means a DeepSeek or Qwen rate or spending limit was reached.
- Confirm the key was created in the provider account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real Bilibili and YouTube videos. Automated checks do not prove that live provider requests and video page interactions work.

## License

MIT. See [LICENSE](LICENSE).
