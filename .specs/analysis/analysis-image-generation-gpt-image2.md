# Analysis — Image Generation Refactor & GPT-Image2 Optimization (Phase 2b)

- Task: `.specs/tasks/todo/refactor-image-generation-gpt-image2.refactor.md`
- Scope: (a) separate image-generation code, (b) optimize the GPT-Image2 path, (c) fix image-pipeline defects.
- Method: read-only repo exploration (2026-09-15) + prior web research in `.specs/scratchpad/103f26a5.md`.
- Repo state: HEAD `784e8e2`; the generate-flow-refactor work (single-chapter stabilization) is **uncommitted in the
  working tree** (`src/core/images.ts` modified; `src/stores/generate.ts`, `src/components/generate/**` untracked).
- No application code was modified by this phase.

---

## 1. Affected Files

### 1.1 Modify

| # | Path | Current responsibility | Why affected | Key functions/types |
|---|---|---|---|---|
| M1 | `src/core/images.ts` (1925 ln) | Image monolith: task graph, prompt constants, reference resolution, retry/moderation, cutout/self-check orchestration, asset ledger, repair | (a) split into modules; (b) per-provider request shaping; (c) defects D1–D6, D9–D12 touch this file directly | `buildImageTasks` L270, `taskSeedForId` L453, `runImageTask` L810, `generateImages` L1157, `repairImageAssets` L1754, `ImageRunOptions` L588, prompt constants L83‑154 |
| M2 | `src/core/regenerate.ts` (416 ln) | Single-asset / batch regeneration runner (layers, progress, incremental assets.json merge) | Needs the same provider policy + shared retry/executor; candidate move into `core/image/` | `RegenContext` L19, `regenerateImages` L84, `imageTaskMatchesSelectionKey` L234, per-asset wrappers L258‑364 |
| M3 | `src/core/visualBible.ts` (2630 ln) | Visual gate image generation (style sample, three-views, costume sheets, action sheets) calling `generateImage` directly | Shares API path but bypasses `runImageTask`: shaping, moderation ladder, size policy, capability errors must be unified; style sample size 1024x576 is invalid for GPT-image | deps interface ~L80‑100, `generateImageWithModerationRetry` L532, `generateCostumeSheets` L478, `createDraftStyle` L638 (size L666), threeview L715, regen entry points L833/857/905/1032/1282 |
| M4 | `src/core/pipeline.ts` (2072 ln) | Stage orchestration; builds `generateImages` args positionally (L1840‑1869) | New options (quality/background/format, request policy) must be plumbed; positional signature is a hazard | `PipelineInput` L46, image stage L1796‑1900, `imageSeedFor` L166 |
| M5 | `src/core/chapterAssets.ts` (40 ln) | Chapter-scope image task coverage ("chapter lamp") | Must stay byte-identical with the task graph after split; if task ids/file names change, coverage breaks | `chapterScopeImageTasks` L17 |
| M6 | `src/core/stageCascade.ts` (144 ln) | Missing-asset counting / cascade decisions | Same task-graph parity requirement | `statusImageTasks` L62, `missingImageTaskCount` L91 |
| M7 | `src/core/selfcheck.ts` (69 ln) | Multimodal image self-check; system prompt requires "background is pure color (green screen)" | If transparent-background generation is adopted for figures/items, verdict rules must change | `verifyImage` L41, `SYSTEM` L15‑21 |
| M8 | `src/api/templates.ts` (262 ln) | Provider adapter templates | gpt-image needs response_format/seed removal, size/quality/background/output_format mapping, edits multipart template; Gemini/Stability refresh | `openai-image` L8‑27 (D1/D2), `siliconflow-image` L29, `minimax-image` L66, `dashscope-image` L130, `gemini-image` L198, `stability-image` L213 |
| M9 | `src/api/universal.ts` (718 ln) | Generic HTTP caller: request build, retries, decode, poll | Multipart file parts for `/images/edits`, pathPrefix for image URLs, Retry-After-aware single retry policy, payload-size guards | `postJson` L390, `buildMultipartBody` L368, `joinUrl`/`callUnified` L515/L530, `unifiedImage` L658, `RETRY_DELAYS` L355 |
| M10 | `src/api/providers.ts` (430 ln) | Provider presets, model classification, capability table, reference routing | Add current GPT-image models (2.5 flare/sunburst, 1.5, 1-mini), raise ref cap 3→16, per-model size/param helpers, retire dall-e defaults | `KNOWN_IMAGE_CAPABILITIES` L42, `resolveImageModelCapabilities` L87, `routeImageReferences` L116, `protocolForConfig` L170, `PROVIDERS` L293 (openai L311) |
| M11 | `src/api/openaiCompatible.ts` (1104 ln) | `generateImage` entry, concurrency, test/probe, capability write-back | Request shaping options; fix probe false positives/negatives; fix test sizes; retire dall-e builtins; keep abort/limiters | `generateImage` L861, `testImage` L1079, `probeImageEditSupport` L1063, `setImageConcurrency` L56, `withRetry` L335 |
| M12 | `src/utils/errorClassifier.ts` (131 ln) | 7-way error classification driving retry/rewrite | Add permanent billing/quota codes, output-stage moderation signature, `unknown_parameter`; prevents retry storms | `classifyError` L88, patterns L15‑85 |
| M13 | `src/pages/ConfigPage.vue` (778 ln) | API configuration UI incl. image template select, capability editor (0‑3 refs), test connection | Expose new policy knobs; raise ref cap; test warning/cost; show actionable OpenAI errors | `runTest` L211, capability editors L271‑296, image details L652‑686, custom template L687 |
| M14 | `src/components/generate/OptionsPanel.vue` | Generation options (style/seed/budget/…) | Add optional quality/background/format controls if user-facing; otherwise no change | props from `stores/generate` |
| M15 | `src/components/generate/result/AssetPanel.vue` (293 ln) | Asset grid, batch regen, per-asset regen, cutout, missing-fill | Wire new provenance (transparent/re-encoded) and keep regen locks | `regenSelected` L98, `regenMissingImages` L99 |
| M16 | `src/components/VisualBiblePanel.vue` (~49 KB) | Visual gate review + per-asset regen | Affected by shared policy/errors; no behavior change expected | regen calls into `core/visualBible.ts` |
| M17 | `src/stores/generate.ts` (3796 ln) | Run state single source; regen contexts and all asset regen entry points | Pass new options through `regenImageCtx`; keep queue/abort/locks | `regenSelected` L962, `regenMissingImages` L996, `regenCtx` L2532, `regenImageCtx` L2597, repair L2968 |
| M18 | `src/stores/project.ts` | `GenerationOptions` defaults + snapshot persistence | New image options must default + persist/restore | defaults L41‑52, `snapshotProjectState` L85 |
| M19 | `src/stores/configMigration.ts` | Config schema v3, defaults, serialization | Capability/policy payload lives in `ApiConfig.extra`; add migration for probe/capability versioning | `CONFIG_SCHEMA_VERSION` L3, `DEFAULT_CONCURRENCY_BY_CHANNEL` L6, `concurrencyFor` L14 |
| M20 | `src/stores/config.ts` | Presets/active config, `applyTemplate`, secrets orchestration | Apply-template must clear stale per-model capabilities; defaults touch | `applyTemplate` L83, `defaultApiConfig` L51, `activeConfig` L275 |
| M21 | `src/i18n/en.ts` / `ja.ts` / `ko.ts` / `zh-TW.ts` + `scripts/i18n-keys.txt` | UI strings (zh source inline) | New config/error strings must be translated + key list regenerated | key parity script |
| M22 | `src-tauri/src/commands.rs` (731 ln) | `http_request` bridge: 64 MiB request/response cap, timeout clamp 1‑600 s | Conditional: raise caps or stream for 2K/4K b64 and multipart edits; otherwise document limits | `HTTP_BODY_LIMIT` L15, `limited_response_bytes` L50, `http_request` L72 |
| M23 | `tests/unit-image-prompt.ts` | `imagePromptLimitFor`/`fitImagePrompt` contracts | If a gpt-image limit or new prompt skeleton is added, expectations change | L47‑52 |
| M24 | `tests/unit-image-references.ts` (43 KB) | Reference routing/probe/cache-binding contracts | Capability limit 3→16, dedup/required semantics, probe rules | `testCapabilitiesDedupAndLimits` L129, `testZeroReferenceModelRejects…` L398, cache-binding L550+ |
| M25 | `tests/unit-providers.ts` | Provider/model classification | New model entries + defaults change assertions | `PROVIDERS`/`parseModelList` L15‑42 |
| M26 | `tests/unit-image-reference-route.ts` | Relay 413 → typed error, no retry | Add probe false-positive regression (probe must send a *required* ref before claiming edit support) | `relayConfig` L21, `testImageRequestIsNotRetried…` L59 |

### 1.2 Create

| # | Path | Purpose |
|---|---|---|
| C1 | `src/core/image/types.ts` | Image-local types: `ImageTask` subset, `ImageResultMap`, `BuildImageTaskOptions`, `ImageRunOptions`, `ImageReferenceResolutionContext` |
| C2 | `src/core/image/tasks.ts` | `buildImageTasks`, `taskSeedForId`, `chapterCharacterIds`, `chapterItemIds` (pure task graph) |
| C3 | `src/core/image/prompts.ts` | Style/emotion/background suffix constants, `emotionPrompt`, `stripBackground`, `fitImagePrompt`, prompt-limit parsers, prompt-hygiene helpers |
| C4 | `src/core/image/references.ts` | `resolveImageTaskReferences`, `fileReference`, visual-bible artifact path resolution, material→reference mapping |
| C5 | `src/core/image/execute.ts` | `runImageTask` (single task: cache → refs → generate → cutout → self-check), moderation ladder, provider policy call |
| C6 | `src/core/image/batch.ts` | `generateImages` (scope narrowing, cache partition, dependency passes, progress, abort, ledger write) |
| C7 | `src/core/image/ledger.ts` | `updateAssetMap` merge, legacy CG migration, `repairImageAssets`, orphan purge/report |
| C8 | `src/core/image/regen.ts` | Move of `core/regenerate.ts` (batch regen + per-asset helpers) sharing C5 |
| C9 | `src/api/image/policy.ts` | Per-provider/model request policy: size matrix, quality/background/output_format, seed/response_format gating, ref routing/encoding, payload expectations |
| C10 | `src/api/image/openai.ts` | GPT-image family specifics: request shaping, actionable error mapping (org verification, moderation stages), optional `/v1/images/edits` multipart adapter |
| C11 | `src/api/image/probe.ts` | Capability probing redesign: real required reference, response verification, non-destructive write-back rules |
| C12 | `tests/unit-image-request-shape.ts` | Golden request bodies per provider/model (no `response_format`/`seed` for gpt-image; size policy; pathPrefix) |
| C13 | `tests/unit-image-provider-matrix.ts` | Capability/size/quality matrix per model incl. 2.5 flare/sunburst, retired dall-e |
| C14 | `tests/unit-openai-edits.ts` (conditional) | Multipart `image[]` construction + role ordering + size/format guards, if edits endpoint is adopted |

### 1.3 Delete / Move

| Kind | Target | Rationale |
|---|---|---|
| Delete | `src-tauri/src/config.rs` | Dead legacy config (`image_gen_url`, `background_color_threshold`); file is not declared in `lib.rs` (`mod commands; pub mod cutout; pub mod models; mod server;` L1‑4), so it is never compiled — stale defect surface (D10) |
| Move | `src/core/images.ts` → `src/core/image/*` (C1‑C7) | Keep `src/core/images.ts` as a barrel re-export so the 12+ importers and tests keep compiling; delete the shim only after a follow-up pass |
| Move | `src/core/regenerate.ts` → `src/core/image/regen.ts` (C8) | Same domain; keep old path re-export during transition |
| Move (optional) | `chapterAssets.ts` + `stageCascade.ts` task builders → `src/core/image/coverage.ts` | Single source for coverage/cascade counting; optional, mechanical |

---

## 2. Interfaces & Signatures

### 2.1 Image task graph / execution (current)

```ts
// src/core/images.ts
export interface BuildImageTaskOptions {           // L244-268
  figurePerCharacter?: number; cgPerChapter?: number; maxPerChapter?: number;
  figureEmotions?: boolean; detail?: FigureDetail; style?: string; feedback?: string;
  threeView?: boolean; actions?: boolean; maxActionsPerCharacter?: number;
  baseSeed?: number; styleAnchor?: boolean; chapterIndexes?: Set<number>;
}
export function buildImageTasks(chapters: ChapterScript[], cards: ExtractionResult,
  opts?: BuildImageTaskOptions): ImageTask[];                       // L270
export function taskSeedForId(baseSeed: number, taskId: string): number; // L453

export interface ImageRunOptions {                 // L588-617
  materials?: MaterialAsset[]; force?: boolean; figureBase?: Record<string, string>;
  visualBible?: ProjectVisualBible; outputDir?: string;
  verifyCfg?: ApiConfig; visionCfg?: ApiConfig; safeRewriteCfg?: ApiConfig;
  styleAnchorPath?: string; negativePrompt?: string; retryCount?: number;
  isAborted?: () => boolean; retryDelayMs?: number;
}
export async function runImageTask(cfg: ApiConfig | undefined, task: ImageTask,
  cacheRoot: string, log: (ev: PipelineEvent) => void,
  opts?: ImageRunOptions): Promise<string | null>;                  // L810

export async function generateImages(                               // L1157-1183 (20 positional params!)
  cfg: ApiConfig | undefined, chapters: ChapterScript[], cards: ExtractionResult,
  materials: MaterialAsset[], cacheRoot: string, log: (ev: PipelineEvent) => void,
  concurrency = 3, figureEmotions = true, style?: string, feedback?: string,
  force = false, threeView = true, withActions = true, verifyCfg?: ApiConfig,
  baseSeed?: number, styleAnchor = true, isAborted?: () => boolean,
  visualBible?: ProjectVisualBible, visionCfg?: ApiConfig, safeRewriteCfg?: ApiConfig,
  cgPerChapter = 0, maxPerChapter = 0, chapterScope?: Set<number>,
  figureDetail: FigureDetail = "full", chapterForce: Set<number> = new Set(),
): Promise<{ images: ImageResultMap; failed: FailedTask[]; generated: number }>;

export async function resolveImageTaskReferences(task: ImageTask,
  context: ImageReferenceResolutionContext): Promise<ImageReference[]>; // L656
export async function repairImageAssets(outputDir: string, opts: {...}, log): Promise<RepairImageReport>; // L1754
```

Proposed (planning-level, not final): replace the `generateImages` positional signature with an options object
(`generateImages(cfg, chapters, cards, io: {cacheRoot, log, materials, onProgress}, opts: ImageBatchOptions)`) and
introduce `ImageRequestPolicy` consumed by both `runImageTask` and the visual-bible path.

### 2.2 API layer (current)

```ts
// src/api/providers.ts
export interface ImageModelCapabilities { maxReferenceImages: number; supportsSeed: boolean;
  supportsImageEdit: boolean; referenceEncoding: "raw-base64" | "data-url"; }  // core/types.ts L124
export function resolveImageModelCapabilities(config: ApiConfig): ImageModelCapabilities; // L87
export function routeImageReferences(config: ApiConfig, refs: ImageReference[]): ImageReference[]; // L116
export function protocolForConfig(config: ApiConfig, kind: ChannelKey): ApiProtocol; // L170

// src/api/templates.ts
export function resolveTemplate(cfg): AdapterTemplate | undefined;  // L240
export function templatesForCapability(capability: "image"|"tts"): AdapterTemplate[]; // L260

// src/api/universal.ts
export interface AdapterTemplate { id; capability; mode: "sync"|"async"; endpoint;
  contentType?: "json"|"form"; auth?; requestMap: Record<string, TemplateValue>;
  response: { path?; encoding?; mime? }; poll?; voices?; rawResponse?; }      // L12-55
export function buildRequestBody(template, vars): Record<string, unknown>;     // L174
export async function callUnified(ctx: CallContext): Promise<UnifiedResult>;   // L530
export async function unifiedImage(cfg, template, input: UnifiedImageInput): Promise<UnifiedResult>; // L658

// src/api/openaiCompatible.ts
export async function generateImage(cfg: ApiConfig, prompt: string,
  opts?: { references?: ImageReference[]; size?: string; seed?: number; negativePrompt?: string },
): Promise<{ dataB64: string; mime: string }>;                                  // L861
export async function testImage(cfg: ApiConfig): Promise<{ imageOk; editOk; detail }>; // L1079
```

Proposed additions: `ImageRequestPolicy` (per model family: allowed sizes + default, quality, background,
output_format, whether `response_format`/`seed` may be sent, ref route generations|edits, ref encoding),
`buildEditsMultipart(...)`, `classifyImageError(...)` (permanent vs transient vs policy).

### 2.3 Config / UI / store contracts

```ts
// src/core/types.ts
export interface ApiConfig { id; name; baseUrl; apiKey; model; adapter?;
  concurrency?; extra?: Record<string, unknown>; }         // (extra: protocol/adapter/template/caps/pathPrefix)
export interface GenerationOptions { ... figureDetail?; imageStyle?; imageSeed?; styleAnchor?; ... } // L431-488

// src/stores/configMigration.ts
export const CONFIG_SCHEMA_VERSION = 3;                     // L3
export function concurrencyFor(cfg: ApiConfig|undefined, kind: ChannelKey): number; // L14

// src/stores/generate.ts
async function regenImageCtx(): Promise<RegenContext | null>;  // L2597
```

New persisted fields (if user-facing): e.g. `GenerationOptions.imageQuality`, `.imageBackground`,
`.imageOutputFormat`; `ApiConfig.extra.imagePolicyVersion`, `extra.imageCapabilitiesV2` — all must round-trip
through `utils/persist.ts` (project snapshot) and `stores/configMigration.ts` (global config) and the web runtime
(`utils/vfsWeb.ts` / `webRuntime.ts`).

---

## 3. Integration Points & Impact

1. **Task-graph consumers (byte-stability required).** `buildImageTasks` is used by `generateImages` (images.ts:1304,
   repair 1790), `regenerate.ts:93/296`, `useStageStatus.ts:72`, `chapterAssets.ts:29` (chapter lamp),
   `stageCascade.ts:67`, `visualBible.ts:558`, `stores/generate.ts:1009/2331`.
   Impact: any change to task `id`, `fileName`, or suffix text silently invalidates the image cache and the
   chapter-coverage lamps (mass paid regeneration). Keep output identical during the split; add a golden-snapshot test.
2. **Execution callers.** `runImageTask` is called by `generateImages` pass runner (images.ts:1505) and
   `regenerateImages` (regenerate.ts:184). The visual-bible path calls `generateImage` directly (9 sites).
   Impact: new request shaping/moderation/retry must be placed in the API/policy layer, or the visual gate will drift
   from the generation pipeline (already true for the moderation ladder).
3. **Provider/request contracts.** `generateImage` → `routeImageReferences` → `unifiedImage` → `callUnified`
   → `postJson`. Impact: edits-endpoint adoption changes transport (multipart file parts) and the capabilities
   contract (`maxReferenceImages` 3→16, role ordering); relays keep the generations shape — capability flags must
   express which route to use, never silently drop refs.
4. **Settings schema & persistence.** `ApiConfig.extra.{protocol, adapter, customTemplate, imageCapabilities,
   pathPrefix, discoveredModels}`; global config `ConfigFile` schema v3 + keyring secrets
   (`commands.rs:363/381`); project snapshot keeps `GenerationOptions` (`utils/persist.ts`).
   Impact: new keys need migration + web-runtime parity; capability records must be versioned per model, not per slot
   (D11: switching model in a config slot leaves stale caps).
5. **Events / progress / abort.** `PipelineEvent.progress` (types.ts:499), `emitProgress` (images.ts:1448),
   assets.json live polling in the store (`loadAssetMapNow` L1144, `startAssetLiveRefresh` L1200).
   The "persist assets.json before emitting progress" order (images.ts:1520‑1529) and the cooperative `isAborted`
   checkpoints (L817‑819, 988, 1100, 1525) are load-bearing; preserve them through the split (covered by
   `unit-image-abort.ts`).
6. **Cache formats / invalidation.** Files `cache/images/<kind>_<id>[_<suffix>].{png,jpg,webp}` (cache.ts:15),
   size check `tauri.imageSizeMatches` (images.ts:845/1396; generate.ts:1065), `assets.json` sections
   (assetMap.ts), visual-bible fingerprint marker `.visual-bible-fingerprint` (images.ts:1196‑1202, 1632‑1634),
   artifact dir `.novel2vn/visual-bible` (visualBible.ts:181‑222).
   Impact: adding quality/background/output_format without folding them into the cache key/fingerprint will keep
   serving old renders (D12); size changes already self-heal via the size check.
7. **Test-connection → persisted capability → production refs.** `ConfigPage.runTest` (L211) → `testImage` →
   `generateImage` ×2 → write-back `cfg.extra.imageCapabilities` (openaiCompatible.ts:1087‑1095) → persisted.
   Impact: probe bugs are *permanent configuration damage* (D4); fixes need a config-side reset/version bump.
8. **Rust transport.** `tauri.http` (commands.rs:72) caps request/response at 64 MiB (b64 inflates 4/3),
   reads whole bodies to memory, timeout clamp 1‑600 s. Impact: 2K/4K outputs and multipart edits can approach caps;
   no streaming. `imageSizeMatches`/`hasTransparency`/`cutoutImage` stay.
9. **UI triggers.** Asset panel batch/individual regen (AssetPanel.vue), visual gate regen buttons
   (VisualBiblePanel.vue), chapter workbench "generate selected" (`stores/generate.ts` queue → `pipeline`),
   ConfigPage test/template editing. Impact: new options must reach `regenImageCtx` and the pipeline stage args via
   `GenerationOptions` (single source), or regen diverges from full-run behavior.
10. **Tests as contracts.** `unit-image-abort.ts` (no paid calls after abort; in-flight result kept),
    `unit-image-references.ts` (routing/dedup/limits/cache bindings), `unit-image-reference-route.ts` (413 relay typed
    error, no retry), `unit-image-prompt.ts` (fit/limit), `unit-chapter-image-scope.ts` (task parity),
    `unit-regen-safety.ts`, `unit-visual-bible*.ts`, `unit-partial-rerun.ts`, `unit-stage-cascade.ts`.
    Impact: they pin the behaviors most likely to regress; run all before/after each step.

---

## 4. Existing Patterns to Reuse

1. **Data-driven adapter templates** (`templates.ts` + `universal.ts` `TemplateValue`/`$var`/`{model}`/
   `setByPath`) — add per-model templates/policy instead of `if (model.startsWith("gpt-image"))` branches.
2. **Capability object + reference routing** (`ImageModelCapabilities`, `routeImageReferences`, required/optional
   roles, payload/sourcePath dedup) — extend the type; keep `structure` optional semantics.
3. **Typed errors + classifier**: `ReferenceImageError` (providers.ts:11), `VisionApiError`
   (openaiCompatible.ts:287), `classifyError` (errorClassifier.ts:88) — extend with permanent/unknown-parameter/
   output-moderation classes rather than new ad-hoc string matching.
4. **Moderation rewrite ladder** already exists twice (images.ts:1021‑1060 with LLM; visualBible.ts:532‑555 without) —
   extract one helper and reuse (fixes D9 drift).
5. **Per-API concurrency limiters** (`ConcurrencyLimiter` + `IMAGE_LIMITERS`/`LLM_LIMITERS`, `setImageConcurrency`) —
   reuse for any token-bucket/IPM pacing instead of new global throttles.
6. **Deterministic task seeds** `taskSeedForId` + `baseSeed` (images.ts:434‑447) — keep id-derived seeding; add cache
   fingerprint dimensions carefully (changing seeds invalidates caches).
7. **Cooperative abort + persist-then-emit + dependency layers** (images.ts passes L1462‑1592; regenerate.ts
   `layerOf` L149‑165) — reuse for any new parallel paths; new paid retry paths must respect `isAborted`.
8. **Cache-safe migration precedents**: legacy CG rename/migration (images.ts:1414‑1443, repair 1837‑1888) and
   visual-bible revision cache binding (1639‑1680) — reuse if file names/paths must change.
9. **Executable contract tests** via `scripts/run-tests.mjs` (tsx, all `unit-*.ts`) and the VFS/web runtime
   (`tests/unit-vfs.ts`) — add golden request-body and provider-matrix tests here.
10. **Structured logging with redaction + timing** (`utils/logger.ts`, `redactSensitive`) — image request logs already
    mask keys; keep new fields out of logs.

---

## 5. Defect Candidates (evidence)

Severity: **S1** = money/credentials/permanent config damage; **S2** = wrong output/silent degradation;
**S3** = UX/robustness.

| # | Sev | Defect | Evidence | Impact |
|---|---|---|---|---|
| D1 | S1 | `openai-image` template always sends `response_format: b64_json`; official GPT-image models return 400 `unknown_parameter` (they always return b64) | `src/api/templates.ts:19`; cross-check Phase 2a scratchpad §2 (verified docs) | Official OpenAI GPT-image channel unusable until fixed; relays tolerate it, so bug is invisible on the dev relay |
| D2 | S1 | References are sent as `image`/`image2`/`image3` fields on `/v1/images/generations` — a relay-only shape; official OpenAI edits use `/v1/images/edits` **multipart** `image[]` (≤16, <50 MB). No edits adapter exists; `buildMultipartBody` only emits text fields | `src/api/templates.ts:20-23`; `src/api/universal.ts:368-381`, `538-551` | Native character-consistency (three-view→figure chain) cannot work on official accounts; only relay-shaped providers work |
| D3 | S1 | Capability map misses current models (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest`); presets still default to `gpt-image-1` and builtins include retired `dall-e-3` | `src/api/providers.ts:42-63`, `:82-92`, `:311`; `src/api/openaiCompatible.ts:155`; Phase 2a model table | `resolveImageModelCapabilities` → 0 refs for these models → identity refs silently dropped or typed `REFERENCE_UNSUPPORTED`; seed/params unmanaged |
| D4 | S1 | Capability probe is directionally wrong: (a) it sends a `structure` reference, which `routeImageReferences` treats as **non-required** and drops when capabilities say "no edit" → probe reports `editOk` even though no image was sent; `testImage` then persists `maxReferenceImages: 3, supportsImageEdit: true`. (b) For a known model (e.g. `gpt-image-2`), the reference IS sent via the generations shape; official 400 → probe fails → write-back overwrites the known capability with `0` refs | `src/api/openaiCompatible.ts:1063-1077` (`size: "512x512"`, role `structure`), `:1087-1095`; `src/api/providers.ts:112-114`, `:147-156`; reproduction of the relay case: `tests/unit-image-reference-route.ts:30` | Bad writes are permanent in user config; causes both "refs ignored" (silent drift) and "refs rejected at runtime" (413 relay). Capability write-back must never overwrite known capabilities on failure |
| D5 | S1 | Invalid image sizes on the OpenAI path: test/probe use `512x512`; anchor task and visual-bible style sample use `1024x576`. gpt-image-1/1.5 allow only 1024²/1536×1024/1024×1536/auto; gpt-image-2+ require total pixels ≥655,360 (1024×576 = 589,824) | `src/api/openaiCompatible.ts:1068`, `:1080`; `src/core/images.ts:299-300`; `src/core/visualBible.ts:666`; Phase 2a §2 size matrix | "Test connection" fails on official channels; style anchor generation fails → whole image stage blocked or degrades to no anchor |
| D6 | S2 | `pathPrefix` is honored for chat/vision but ignored for image (and TTS) calls: `chatCompletion`/`chatVision` call `normalizeBaseUrl(baseUrl, pathPrefix)`, while `generateImage` passes raw `cfg` into `callUnified`, which joins `cfg.baseUrl` directly | `src/api/openaiCompatible.ts:373`, `:760` vs `:885`; `src/api/universal.ts:515-532` | Gateways mounted under a path prefix get 404 for images only — confusing, provider-specific failures |
| D7 | S2 | Retry multiplication and missing rate-limit awareness: `postJson` retries up to 8 attempts (1s→10s→…→60s, no jitter) and `runImageTask` retries up to 3 more times → up to ~24 paid attempts per image; `Retry-After`/rate-limit headers are never read; permanent billing 429s are retried as transient | `src/api/universal.ts:355`, `:398-471`; `src/core/images.ts:968-1104`; `src/utils/errorClassifier.ts:33-41`; Phase 2a §3 | Money burn + long stalls on failing keys/quota exhaustion; violates documented OpenAI guidance (honor Retry-After, don't retry billing errors) |
| D8 | S2 | Error-classification gaps for OpenAI image errors: billing/quota 429 codes (`credit_balance_exhausted`, `organization_*_limit_exceeded`) → `rate_limit` (retried); output-stage moderation ("Generated image was filtered") is not matched by any `content_moderation` pattern → classified `invalid_param` (no rewrite, immediate fail); org-verification 400 has no actionable message | `src/utils/errorClassifier.ts:16-41`, `:88-107`; Phase 2a §3 error table | Wasted retries; user sees opaque "参数错误" instead of "finish org verification / buy credits"; output-filtered images are not rewritten |
| D9 | S3 | Two divergent moderation-rewrite ladders: 4-stage with optional LLM rewrite (`images.ts:1021-1060`) and 3-stage without LLM (`visualBible.ts:532-555`) | `src/core/images.ts:1021-1060`; `src/core/visualBible.ts:532-555` | Visual-gate characters/costumes get a weaker rewrite path than production figures; duplicated maintenance |
| D10 | S3 | Dead legacy Rust config: `src-tauri/src/config.rs` defines `image_gen_url` / `background_color_threshold` but is not declared in `lib.rs` (`mod commands; pub mod cutout; pub mod models; mod server;`) | `src-tauri/src/config.rs:5-24`; `src-tauri/src/lib.rs:1-4` | Misleads readers about where the image endpoint lives; safe to delete |
| D11 | S2 | Capability record is stored per API-config slot, not per model: `extra.imageCapabilities` persists after the user switches `cfg.model` in the same slot; the ConfigPage editor also writes at slot level | `src/api/openaiCompatible.ts:1087-1095`; `src/pages/ConfigPage.vue:271-296`, `:652-686`; `src/api/providers.ts:87-92` | Stale caps change ref behavior for the new model (e.g. 0 refs from a failed probe of the old model) with no warning |
| D12 | S2 | Cache invalidation ignores model/quality/background/output_format: cache key is the file name; only width/height are verified; `imageSizeMatches` failures are treated as matching (`.catch(() => true)`) | `src/core/images.ts:844-859`, `:1396`, `:1320-1328`; `src/core/cache.ts:15`; `src/stores/generate.ts:1063-1068` | Once quality/transparent-background knobs exist, switching them silently reuses old renders; a bridge hiccup can accept a wrong-size file as valid |
| D13 | S3 | Gemini/Stability templates have no `$refImage` mapping at all, yet the probe can mark them edit-capable (see D4a); `unifiedImage` only forwards vars referenced by the template | `src/api/templates.ts:198-212` (Gemini), `:213-233` (Stability); `src/api/universal.ts:663-691` | Identity references are silently ignored → character drift with no error; Phase 2a notes Gemini 3 supports up to 14 refs |
| D14 | S3 | Custom-template fallback silently maps unknown protocols to `openai-image` when `adapter` is unset and protocol isn't siliconflow | `src/api/openaiCompatible.ts:866-867` (fallback `getTemplate("openai-image")`); `src/api/templates.ts:240-258` | A misconfigured channel sends OpenAI-shaped JSON to non-OpenAI routes; the error is provider-side and unhelpful |
| D15 | S3 | `maxReferenceImages` is hard-capped at 3 in validation and UI (`> 3` invalid; editor max=3) | `src/api/providers.ts:70-72`; `src/pages/ConfigPage.vue:659-666` | Cannot express gpt-image edits (≤16) or Gemini (≤14) even manually; blocks multi-ref characters/costumes |

Non-defects noted while checking (documented to avoid re-litigating): anchor exclusion from `assets.json`
(image.ts:1368) and orphan-purge exclusion (L1891/1900) are intentional; `stripBackground`/green-suffix prompt tax is
a deliberate workaround until real alpha is adopted.

---

## 6. Risk Assessment

**Overall: High.** This refactor touches the most expensive, cache-sensitive path in the app, and the recent
single-chapter flow is uncommitted (worktree-only), which raises merge/regression risk.

| Risk | Level | Concrete failure mode | Mitigation |
|---|---|---|---|
| R1 Task naming/cache drift | High | Renaming tasks/files or touching prompt suffixes invalidates `cache/images/**`, re-bills the whole book, and breaks chapter lamps (`chapterAssets`/`useStageStatus` parity) | Pure-move split first, zero behavior change; add golden snapshot test for `buildImageTasks` (ids, fileNames, prompt tails) and run `unit-chapter-image-scope.ts` |
| R2 Provider request shaping regression | High | Changing the shared `openai-image` template to satisfy GPT-image breaks relays/SiliconFlow/MiniMax/Gemini; or ref handlers diverge | Policy resolved per model + per adapter; golden request-body tests per template; keep relay shape selectable by capability (`refRoute: "generations"|"edits"`) |
| R3 Capability write-back damaging configs | High | Probe fixes still overwrite user caps on error; users lose working refs silently (already happens on failed probes) | Never overwrite known caps on failed probe; probe with a `required:true` reference and assert the image payload was actually sent; version the capability record; add a reset action + migration |
| R4 Single-chapter/queue & abort regression | High | New retry/parallel code bypasses `isAborted`; queue locks or progress ordering break; stopped runs keep spending | Keep abort checkpoints before every paid call; run `unit-image-abort.ts` + `unit-partial-rerun.ts` + `unit-chapter-scope*`; port the "persist assets.json before emit progress" order |
| R5 Visual-gate path bypass | High | Pipeline fixes (shaping/ladder/retry) land only in `runImageTask`; visual gate keeps old behavior → inconsistent outputs/errors between gate and production images | Centralize policy + moderation ladder in `api/image/*` and make `visualBible.ts` consume it; run `unit-visual-bible*.ts` suites |
| R6 Cost/retry amplification | High | Unifying retries incorrectly multiplies attempts; permanent quota errors keep retrying and burn money | One retry policy module (attempt budget, Retry-After, jitter, permanent classes); total-attempt assertion test; noisy logs on every retry |
| R7 Persistence/schema drift | Medium | New `GenerationOptions`/extra keys not restored on project switch or web runtime; i18n keys missing | Update `utils/persist.ts` snapshot + `configMigration.ts` + `webRuntime/vfsWeb` parity; run `unit-persist.ts`, `unit-vfs.ts`, i18n key script |
| R8 Rust transport caps / multipart | Medium | 2K/4K b64 or multipart edits exceed the 64 MiB body/response cap; no streaming → hard error | Measure real payloads; gate high-res behind size policy; for edits consider `body_base64` part assembly and raise canal caps deliberately; document limits in UI |
| R9 Test-suite fragility | Medium | Dozens of untracked `.tmp-*` test trees and worktree files make "green baseline" ambiguous; new tests can pass locally against stale fixtures | Capture a baseline (`node scripts/run-tests.mjs`) before changes; avoid relying on `.tmp-*`; add new tests as `unit-*.ts` |
| R10 Scope creep into gpt-image 2.5 features | Medium | Adopting transparent background / edits / quality policy all at once multiplies behavior changes | Stage the work: (1) split + correctness fixes (D1/D3/D4/D5/D8), (2) policy/shaping + tests, (3) optional transparent/edit enhancements behind capability flags |

---

## 7. Suggested Module Boundaries (candidate only)

```
src/core/image/                    # "separate image-generation code" (moved from core/images.ts)
  types.ts        ImageTask/ImageResultMap/ImageRunOptions/BuildImageTaskOptions
  tasks.ts        buildImageTasks, taskSeedForId, chapterCharacterIds/ItemIds
  prompts.ts      style/emotion/green-suffix constants, emotionPrompt, stripBackground,
                  fitImagePrompt, prompt-limit parsers
  references.ts   resolveImageTaskReferences, fileReference, visual-bible artifact paths
  execute.ts      runImageTask (cache → refs → generate → cutout → self-check) + moderation ladder
  batch.ts        generateImages (scope narrowing, cache partition, dependency passes, progress, abort)
  ledger.ts       assets.json merge, legacy CG migration, repairImageAssets / orphan purge
  regen.ts        regenerateImages + per-asset regen (from core/regenerate.ts)
  coverage.ts     (optional) chapterAssets/stageCascade task-counting parity

src/api/image/
  policy.ts       per provider/model request policy (size matrix, quality, background,
                  output_format, response_format/seed gating, ref route + encoding, prompt budget)
  openai.ts       GPT-image specifics + actionable error mapping (+ edits multipart adapter if adopted)
  probe.ts        testImage / probeImageEditSupport / non-destructive capability write-back

# Compatibility during migration
src/core/images.ts     barrel re-export of core/image/* (deleted in a follow-up)
src/core/regenerate.ts barrel re-export of core/image/regen.ts
```

Guiding rules: keep `buildImageTasks` output byte-stable; route all paid requests through `execute.ts` (pipeline and
visual gate alike); let templates/policy decide provider differences (no provider branching in core); version and never
destructively rewrite persisted capabilities.
