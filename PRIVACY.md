# Privacy

Effective: July 28, 2026

Bilibili Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no Bilibili Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, Bilibili Digest handles:

- the canonical URL and video ID of the active Bilibili or YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- screenshots you take of the video frame when saving a note;
- content you ask to translate;
- notes you save;
- Supadata, DeepSeek, and Qwen configuration, including API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### Bilibili subtitle API

On a Bilibili video page, Bilibili Digest requests that video's subtitle JSON directly from Bilibili's subtitle API (`aisubtitle.hdslb.com`) using the video's own credentials in the active tab. It does not send your API keys to Bilibili. Bilibili may collect data under its own terms and privacy policy.

### Supadata

Bilibili Digest sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key when you view a YouTube transcript. It uses the same fallback path when a Bilibili video has no native subtitle track. Supadata returns the transcript and timestamps. A Supadata key is required for YouTube transcript retrieval.

### DeepSeek

The published version sends AI text feature content to DeepSeek V4 Flash at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese translation, or requested overview or explanation content; and
- nearby transcript context and video metadata when polishing a saved note.

The endpoint and `deepseek-v4-flash` model are fixed in the published Settings page. You provide one DeepSeek API key. To use another provider or model, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

### Qwen (DashScope)

The published version sends screenshot-aware task content to Qwen VL Plus at `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` with your Qwen API key. These tasks include summarizing a saved note screenshot and explaining the current video frame. The endpoint and `qwen-vl-plus` model are fixed in the published Settings page. Without a Qwen key, vision tasks are unavailable and the rest of the extension keeps working.

Requests go directly from the extension to Bilibili, Supadata, DeepSeek, or Qwen. They are authenticated with the keys you supply. Bilibili Digest's developer does not proxy or receive transcript, screenshot, or AI request content.

## To remove data

- Delete individual saved notes in Bilibili Digest.
- Use the Options page to clear cached digests, delete all notes, or reset all extension data.
- Remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, screenshots, and cache entries.
- Revoke keys in the Supadata, DeepSeek, or DashScope console to stop their future use.

Clearing local data does not delete information already processed or retained by Bilibili, Supadata, DeepSeek, or Qwen. Use each service's controls for service-side requests.

## Permissions

Bilibili Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the Bilibili Digest interface beside Bilibili and YouTube pages.
- `storage`: store settings, keys, notes, screenshots, and cached results locally.
- `tabs`: identify and interact with the active Bilibili or YouTube tab.
- `scripting`: coordinate the extension's video page controls.
- Bilibili host access: read the active video's URL and metadata, and fetch its native subtitle track.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Supadata host access: retrieve transcripts.
- DeepSeek host access: provide AI overviews, explanations, translation, and note polishing through DeepSeek V4 Flash.
- DashScope host access: provide screenshot summaries and frame explanations through Qwen VL Plus.

Bilibili Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

Bilibili Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
