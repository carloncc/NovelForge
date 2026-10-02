---
name: gpt-image-generation
description: "Use when working on image generation/editing integrations in this app (NovelForge) or when optimizing prompts/API calls for OpenAI GPT-Image models (gpt-image-2.5/gpt-image-2). Covers current model IDs and parameters, generations vs edits endpoints, transparency, rate limits/retries, moderation handling, provider differences (Gemini/Nano Banana, relays), and known codebase integration points. Verified 2026-09-15."
---

# GPT-Image Generation (OpenAI) — Integration & Optimization Skill

Verified **2026-09-15**. OpenAI changes image APIs frequently (2.5 shipped 2026-09-08, 2.0 on 2026-04-21); re-verify model IDs/params before relying on them.

## When to use

- Changing how the app generates/edits images (`src/core/images.ts`, `src/api/openaiCompatible.ts`, `src/api/templates.ts`, `src/api/providers.ts`).
- Optimizing prompts for character consistency, three-view sheets, expressions/outfits/actions, backgrounds, CGs, or item cutouts.
- Debugging image API failures: 400 unknown parameter, 429s, moderation blocks, missing references, transparency issues.
- Adding/switching image providers (OpenAI vs Gemini/Nano Banana vs SiliconFlow/MiniMax relays).

## Current model landscape (as of 2026-09-15)

| Model ID | Snapshot | Notes |
|---|---|---|
| `gpt-image-2.5-sunburst` | `...-2026-09-08` | Highest quality + editing precision; slower/longer generations |
| `gpt-image-2.5-flare` | `...-2026-09-08` | Default choice; quality ≈ gpt-image-2 at ~50% lower latency |
| `gpt-image-2` | `gpt-image-2-2026-04-21` | Previous gen; arbitrary resolutions; transparent bg (preview) |
| `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` | — | Legacy; `input_fidelity` supported on 1/1.5 only |
| `dall-e-2` / `dall-e-3` | — | **Retired 2026-05-12** (reported) — do not target |

- GPT-Image models require **API Organization Verification**; without it, requests fail with an actionable 400.
- Quality levels on 2.5: `auto|low|medium|high|xhigh|max`. Selection rule: start with **Flare**; keep Sunburst only where quality demands; use `low` for high-volume latency-sensitive work; `xhigh`/`max` only when a quality requirement is unmet.

## API essentials

### Endpoints
- `POST /v1/images/generations` — text → image.
- `POST /v1/images/edits` — image(s) → image. **Multipart/form-data only** (JSON → 400 `unsupported_content_type`).
  - `image`: one file or an array; GPT-image models accept **up to 16 images**, PNG/JPEG/WebP, **< 50 MB each**.
  - `mask`: PNG, **< 4 MB**, same dimensions as the first image; **fully transparent pixels = region to edit**; prompt-guided, not pixel-exact; applies to the first image only.
- Streaming: `stream: true` + `partial_images: 0–3` (either endpoint family).
- Optional Responses API `image_generation` tool for conversational/multi-turn editing (`action`, `previous_response_id`, file IDs) — not used in this app.

### Parameter cheat-sheet
| Param | Values | Notes |
|---|---|---|
| `model` | `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` / `gpt-image-2` | Call current models directly, not via Responses `model` field |
| `prompt` | ≤ 32,000 chars (GPT-image) | Structure: subject/use → composition → details → constraints |
| `size` | 2.5/2: `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, or any `WxH` | Custom rules: edges ≤ 3840, **multiples of 16**, ratio ≤ **3:1**, total px 655,360–8,294,400; > 2560x1440 experimental. 1/1.5: only 1024², 1536x1024, 1024x1536, auto |
| `quality` | `auto`(default)/`low`/`medium`/`high` (+ `xhigh`/`max` on 2.5) | Labels are not comparable across models |
| `background` | `auto`(default)/`opaque`/`transparent` | Transparent needs `png`/`webp`; never `jpeg` |
| `output_format` | `png`(default)/`jpeg`/`webp` | WebP/JPEG shrink payloads |
| `output_compression` | 0–100 | JPEG/WebP only |
| `n` | 1–10 | Counts toward cost/rate limit |
| `moderation` | `auto`/`low` | Lowers strictness only; policy always enforced |
| `input_fidelity` | `low`/`high` | **gpt-image-1/1.5 only. Do NOT send to 2/2.5** (always high fidelity; parameter disabled/unsupported) |
| `response_format` | dall-e only | **GPT-image models always return `b64_json`; sending `response_format` → 400 `unknown_parameter`** |
| `seed` | — | **Not supported by OpenAI image models** (relay-only feature) |

### Response shape
`{ created, background, data: [{ b64_json }], output_format, quality, size, usage }` — expect `b64_json` (never `url`); b64 ≈ 4/3 of file bytes (1–3 MB typical at 1K, tens of MB at 4K). Budget ≥ 300 s HTTP timeouts for `high`+ quality; Sunburst slower than Flare.

### Consistency & transparency prompting (official patterns)
- **Assign roles to references**: number each input (subject / style / clothing / background) and say how to combine them.
- **Edits**: "change only X", list what must stay identical (identity, geometry, lighting, labels), state exclusions ("no text/logos/watermark"). Repeat constraints across iterative edits; composite outside the model when a region must be pixel-identical.
- **Character consistency**: establish one reusable character reference (e.g. three-view sheet) → reuse it as input for every scene/pose → repeat defining details (outfit, palette, proportions) → "do not redesign the character", "same facial features".
- **Transparent cutouts**: request isolation in the prompt **and** `background="transparent"` + PNG/WebP; verify the real alpha channel (hair/edges/glass); a drawn checkerboard is not transparency.
- Keep prompts maintainable (labeled sections / short descriptive blocks); trim provider-specific negatives unless the provider supports them.

## Errors, rate limits, retries

- **429**: honor `Retry-After` (minimum), then jittered exponential backoff; limits are org-level and enforced over **sub-minute windows**, so cap in-flight requests (~80% of tier IPM) and pace. Published gpt-image-2 tiers: T1 5 IPM / 100k TPM … T5 250 IPM / 8M TPM; **free tier not supported**.
- **Do not retry**: moderation/content-policy rejections (`moderation_blocked`, `image_generation_user_error`), auth/org-verification, billing/quota codes (`credit_balance_exhausted`, `*_spend_limit_exceeded`, `organization_usage_limit_exceeded`), invalid params (`unknown_parameter`).
- **Do retry**: 429 temporary rate limits, 5xx/`overloaded`, network/timeouts — with backoff.
- **Moderation is two-stage** (input filter on prompt/refs; output filter on the image). Message wording distinguishes input vs output block; rewrite strategy differs (word-level vs scene-level). The **edits endpoint screens more strictly** than generations; fallback pattern: LLM-describe image → regenerate via generations. Optional free pre-check: `POST /v1/moderations`.

## Provider differences (what changes)

| Aspect | OpenAI GPT-Image | Gemini / Nano Banana | SiliconFlow / MiniMax (relays) |
|---|---|---|---|
| Current models | `gpt-image-2.5-flare/sunburst` | NB1 `gemini-2.5-flash-image`, NB2 `gemini-3.1-flash-image`, Pro `gemini-3-pro-image` | vendor-specific |
| Endpoint shape | generations JSON / edits multipart | `:generateContent`, `candidates[0].content.parts[].inlineData` | varies; often generations + inline base64 refs |
| Size param | `size` WxH (multiples of 16, ≤3:1) | resolution + aspect ratio (incl. 16:9/21:9) | `image_size` / `aspect_ratio` |
| Reference images | ≤16 (edits), <50 MB each | **≤14** (mix objects/characters) | often ≤3 (`image`/`image2`/`image3`) |
| Transparency | `background=transparent` (PNG/WebP) | prompt-driven, less reliable | prompt-driven |
| Seed | not supported | `seed` supported | supported (SiliconFlow) |
| Other | org verification; b64 always | SynthID watermark + C2PA; optional web/image grounding | relays may reject body with base64 refs entirely |

Rule: never assume one provider's parameters work on another — keep per-provider adapter templates and a capability map, and probe on "test connection".

## Integration notes for this codebase

- Task graph & orchestration: `src/core/images.ts` (`buildImageTasks` ~L270, `runImageTask` ~L810 with retry + moderation rewrite ladder, `generateImages` ~L1157, cutout `ensureCutout` ~L476, vision self-check ~L1120).
- Request layer: `src/api/openaiCompatible.ts` `generateImage` ~L861; capability resolution in `src/api/providers.ts` `resolveImageModelCapabilities` / `KNOWN_IMAGE_CAPABILITIES`.
- Adapter templates: `src/api/templates.ts` (`openai-image` posts to `/v1/images/generations` with `response_format: b64_json` and relay-style `image`/`image2`/`image3`; also `siliconflow-image`, `minimax-image`, `gemini-image`, etc.).
- Error classes: `src/utils/errorClassifier.ts` (content_moderation / rate_limit / auth / invalid_param / network / aborted / unknown).
- Known gaps to check before touching this area (verify they still exist at edit time):
  1. `openai-image` template sends `response_format` and `seed` unconditionally — invalid on official OpenAI GPT-image models (relays may tolerate it).
  2. References via `image`/`image2`/`image3` on generations is non-standard; native OpenAI needs `/v1/images/edits` multipart `image[]`.
  3. `KNOWN_IMAGE_CAPABILITIES` lags current model IDs (no 2.5 entries; provider default is legacy `gpt-image-1`).
  4. No quality/background/output_format/moderation knobs in the request path; figures/items rely on chroma-key green + cutout instead of real alpha.
  5. Retry loop ignores `Retry-After`/rate-limit headers and lacks per-tier pacing.
  6. Task sizes limited to 1024x1024 (figures/items) and 1536x1024 (bg/CG); 2K/4K options unused.

## 复核补记（2026-09-21，来源：OpenAI 官方 SDK `openai@7.20.0` 类型定义）

本机直连 developers.openai.com 返回 403（地区风控），改用**官方 npm SDK 的类型定义**（由官方 OpenAPI 规格生成）复核编辑端点，修正/补充如下：

- `POST /v1/images/edits` 参数（SDK `ImageEditParamsBase`）：`image`（1 张或数组，GPT 系 ≤16、png/webp/jpg、<50MB/张，dall-e-2 1 张 <4MB）、`prompt`（GPT 系 ≤32000 字符）、`mask`（PNG <4MB、与第一张同尺寸、透明=编辑区、仅第一张）、`background`、`input_fidelity`、`n`(1–10)、`output_compression`、`output_format`、`partial_images`(0–3)、`quality`（low/medium/high/auto；2.5 另支持 xhigh/max）、`response_format`（仅 dall-e-2；GPT 恒 b64_json）、`size`、`stream`、`user`
- **edits 没有 `moderation` 参数**（只有 generations 有）——第三方页面列出的「edits 支持 moderation」不准确
- `input_fidelity`：SDK 原文是 **gpt-image-2 / -2026-04-21 会「忽略」该参数**（不是报 400）；2.5 flare/sunburst 明确支持 `opaque`/`transparent`
- `transparent`：2.5 flare/sunburst（含 2026-09-08 快照）正式支持；**gpt-image-2 仍属 preview** → 要透明底优先 1.5/2.5 或保留绿幕+抠图
- `size`：2.x 支持任意 `WIDTHxHEIGHT`（两边 16 的倍数、比例 1:3–3:1、最大 3840×2160、>2560×1440 实验性；还需满足模型当前像素/边长限制）；标准档 1024²/1536×1024/1024×1536；`auto` 视模型而定
- Responses API `image_generation` 工具支持 `action: generate|edit|auto` + `input_image_mask`（image_url/file_id）用于多轮编辑
- 官方模型清单：`gpt-image-2` / `gpt-image-2-2026-04-21` / `gpt-image-2.5-sunburst(-2026-09-08)` / `gpt-image-2.5-flare(-2026-09-08)` / `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini` / `chatgpt-image-latest`（SDK 默认 `gpt-image-1.5`）
- 本项目落地（表情差分）：`src/api/imageEdits.ts`（GPT 系走 edits multipart，其余线路与原失败回退不变）、`ImageTask.editVariant: "expression"`

## Pitfalls checklist

- [ ] Never send `response_format`/`seed`/`input_fidelity` to models that reject them.
- [ ] `/v1/images/edits` must be multipart, not JSON; mask = PNG <4 MB, same size, alpha=edit region.
- [ ] Moderation rejections are deterministic — rewrite, never blind-retry; pre-check with `/v1/moderations` if risky.
- [ ] Billing/quota 429 codes are not rate limits — stop and surface.
- [ ] Pace parallel workers to the account tier (org-level IPM/TPM); don't tighten loops (limits are sub-minute).
- [ ] Long timeouts for high/xhigh/max; avoid retry storms.
- [ ] Verify transparency by real alpha channel, not visual "transparency"; keep cutout fallback.
- [ ] Repeat preserve-constraints on every iterative edit; drift is cumulative.
- [ ] Re-verify model IDs/snapshots at use time; dall-e is retired.

## References (accessed 2026-09-15)

- OpenAI image generation guide: https://developers.openai.com/api/docs/guides/image-generation
- OpenAI 2.5 prompting guide: https://developers.openai.com/api/docs/guides/image-prompting
- Model cards: https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst · /gpt-image-2.5-flare · /gpt-image-2
- Generations reference: https://developers.openai.com/api/reference/resources/images/methods/generate/
- Edits reference: https://developers.openai.com/api/reference/python/resources/images/methods/edit/
- Rate limits & retries: https://developers.openai.com/api/docs/guides/rate-limits · https://help.openai.com/en/articles/5955604
- Org verification: https://help.openai.com/en/articles/10910291
- Cookbook prompting guide: https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- Gemini Nano Banana: https://ai.google.dev/gemini-api/docs/image-generation · https://deepmind.google/models/gemini-image/pro/
- Production patterns (corroboration): https://teachmeidea.com/openai-image-api/ · https://wavespeed.ai/blog/posts/gpt-image-2-rate-limits-2026/ · https://help.apiyi.com/en/fix-gpt-image-2-moderation-blocked-400-error-en.html
