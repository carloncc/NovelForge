---
title: Project visual bible and independent vision API
status: done
type: feature
depends_on: []
---

## Original User Intent

Separate image understanding from the text LLM because the best text model may not support images. Before bulk image generation, let a project establish one stable visual style from either an uploaded reference image or an AI analysis of the whole novel, then generate and approve a style description/reference and one three-view sheet per main character. Every downstream image must use the approved references. Three-view sheets must support explicit regeneration and uploaded character references, and regenerating one character must not regenerate every character.

## Description

Add a fourth, independent `vision` API channel and a persistent project-level visual bible. The visual bible is a required approval gate for AI image generation, not for text extraction or script generation. It owns the project style description/reference, character source references, generated three-view sheets, approval state, revision state, and the fingerprint of the inputs that produced it.

The implementation must preserve existing saved configurations and projects. It must never silently drop a required reference and retry as text-to-image. Unsupported image-reference capabilities, unavailable vision models, missing reference files, and stale approval state must be explicit, actionable failures.

Official request-shape references:

- SiliconFlow multimodal chat (`image_url`, including multiple images): https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
- SiliconFlow Qwen Image Edit (`image`, `image2`, `image3`, URL or data URL): https://docs.siliconflow.cn/cn/api-reference/images/images-generations

## Acceptance Criteria

1. API settings expose independent `llm`, `vision`, `image`, and `tts` channels; all image understanding uses `vision`, never `llm`.
2. Existing three-channel configuration files migrate once without data loss. New presets default vision to SiliconFlow `zai-org/GLM-4.6V` and image generation to the reference-capable `Qwen/Qwen-Image-Edit-2509` preset.
3. A vision connection test submits a bundled tiny raster through the OpenAI-compatible multimodal chat request and succeeds only when the response contains a non-empty visual description.
4. A project can create a visual-bible draft from exactly one selected style source: an uploaded reference image or whole-novel text analysis.
5. The confirmation surface displays the style description, style reference/sample, and every main character's three-view sheet. Users can edit/rewrite style, regenerate the style sample, regenerate one three-view, and approve only when all required artifacts exist.
6. Bulk image generation is blocked until the current visual-bible fingerprint is approved. Text extraction and script generation remain runnable before approval.
7. Every character image uses that character's approved identity/three-view reference; backgrounds and CG use the approved global style reference. Routing respects model reference limits and preserves deterministic role order.
8. A model with insufficient reference capability fails with `REFERENCE_UNSUPPORTED`; a missing file fails with `REFERENCE_MISSING`. Neither path retries without references.
9. Regenerating character A's three-view selects only A's three-view, default figure, expressions, and actions, in dependency order, even when the global character-poses option is disabled.
10. Restarting and loading a project restores its visual bible, approval state, revisions, and file-backed references without storing large base64 payloads in project JSON.

## Architecture And Contracts

### Public Types

Extend the existing contracts in `src/core/types.ts` (names may be split into a dedicated visual-bible module, but the exported wire shape is fixed):

```ts
export type ChannelKey = "llm" | "vision" | "image" | "tts";

export type VisualBibleStatus = "draft" | "approved" | "stale";
export type StyleSource = "reference_image" | "novel_analysis";
export type ImageReferenceRole = "identity" | "style" | "structure";

export interface ImageReference {
  role: ImageReferenceRole;
  dataB64: string;
  mime: string;
  sourcePath?: string;
}

export interface ImageModelCapabilities {
  maxReferenceImages: number;
  supportsSeed: boolean;
  supportsImageEdit: boolean;
  referenceEncoding: "raw-base64" | "data-url";
}

export interface VisualBibleCharacter {
  sourceReferencePath?: string;
  threeViewPath: string;
  prompt: string;
  approved: boolean;
  revision: number;
}

export interface ProjectVisualBible {
  version: 1;
  status: VisualBibleStatus;
  styleSource: StyleSource;
  styleDescription: string;
  styleReferencePath: string;
  characters: Record<string, VisualBibleCharacter>;
  inputFingerprint: string;
  approvedAt?: string;
}
```

`CharacterCard.referenceImage` remains readable as a legacy base64 field during migration. Add a path-backed field for current code; after a successful file migration and save, runtime code must resolve the path and stop propagating base64 through cards/tasks/project state.

### Canonical Storage

- Manifest: `<outputDir>/.novel2vn/visual-bible/visual-bible.json`.
- Uploaded global reference: `style-reference.<ext>`; AI-created sample: `style-sample.png`.
- Character upload: `character-reference_<sanitizedCharacterId>.<ext>`.
- Approved/generated sheet: `threeview_<sanitizedCharacterId>.png`.
- JSON stores only relative or normalized project-local paths, prompts, revisions, status, and fingerprint. It never stores image base64.
- `projectState.visualBible` mirrors the loaded manifest for UI reactivity; `saveProjectState`/`restoreProjectState` load and save the canonical manifest alongside existing state.
- Legacy base64 migration is idempotent: decode to the project-local file, verify it exists, update the path field, then omit the legacy payload on the next persisted write. A failed write leaves the legacy value intact.

### Fingerprint And Invalidation

- Compute the fingerprint deterministically from enabled chapter bodies, extracted character IDs and visual prompts, style source, source reference file bytes/hash when applicable, and the normalized style description. Do not use timestamps.
- Any changed fingerprint changes an `approved` bible to `stale`; image generation remains blocked until approval.
- Editing/reanalyzing global style, replacing its reference, or regenerating its sample invalidates all generated image cache entries and all image mappings (`figure`, `item`, `bg`, `cg`), resets all character approvals, and requires new approval.
- Replacing or regenerating one character's source/three-view invalidates only that character's three-view, default figure, expressions, and actions; background, CG, items, and other characters remain valid.
- Approval is allowed only when the style description and style reference path are non-empty/existing and every extracted main character has an existing three-view with `approved: true`.

### Generation Gate And Resume Flow

- When image generation is requested without a current approved bible, `GeneratePage` runs only the selected text stages through script generation, creates/refreshes the visual-bible draft from the resulting cards, and switches to the approval surface.
- Clicking the final approval action persists the bible and resumes the remaining selected stages (`image`, then optional `voice`, then `assemble`) using cached cards/scripts.
- Direct/non-UI pipeline calls must enforce the same precondition before creating any image task and raise `VISUAL_BIBLE_APPROVAL_REQUIRED` with no partial image writes.
- Projects with `useImage === false` bypass the visual-bible gate.

## Implementation Process

The four steps are sequential. Each step must pass its listed tests before the next begins. Preserve the existing dirty worktree and integrate with current changes; do not revert unrelated modifications.

### Step 1: Add The Independent Vision API Channel [DONE]

**Goal:** Make image understanding independently configurable, migratable, and testable before any feature consumes it.

**Subtasks**

- Extend `ChannelKey`, `ApiChannel`, `ApiPreset.active`, provider capability maps/classification, defaults, and configuration UI to support `vision` as an OpenAI-compatible chat capability.
- Add `configSchemaVersion: 2` to persisted configuration. On loading version 1/missing-version data, create exactly one independent vision configuration per preset by deep-cloning that preset's active LLM configuration (or first LLM configuration), assigning a fresh ID/name, and setting `active.vision`. Persist version 2 so subsequent loads do not clone again. Do not share object/`extra` references.
- New presets use SiliconFlow `https://api.siliconflow.cn/v1` with `zai-org/GLM-4.6V` for vision. Update the new image default/preset to `Qwen/Qwen-Image-Edit-2509`; do not rewrite existing image selections during migration.
- Add `testVision(cfg)` beside the current API probes. It must call multimodal chat with a bundled 1x1 or similarly tiny PNG data URL and a deterministic prompt asking for its visible color/contents. Empty text, refusal to accept `image_url`, or a text-only-model error is failure.
- Route `recognizeStyle`, `recognizeCharacter`, and enabled image self-check callers through `activeConfig("vision")`. Missing/unusable vision config must produce a user-facing configuration error; do not fall back to `activeConfig("llm")`.
- Update ConfigPage labels/descriptions and test dispatch to display four channels and the distinct vision test result without charging an image-generation request.
- Add isolated tests with mocked persisted JSON/fetch for one-time migration, deep-copy independence, new defaults, request body shape, and rejection of a fake text-only response/error.

**Expected Outputs**

- Four-channel configuration types/store/provider/UI with a versioned, idempotent migration.
- A reusable vision probe and all existing image-understanding entry points wired to the vision channel.
- A focused `tests/unit-vision-config.ts` (or equivalent existing-suite additions) runnable without network access.

**Verification**

- **Level:** Panel (high impact: persisted credentials/configuration and cross-feature routing).
- **Artifacts:** configuration type/store migration, ConfigPage channel/test UI, vision request helper, unit-test output, `npm run build` output.
- **Rubric:**

| Criterion | Weight |
| --- | ---: |
| Migration is idempotent, preserves all old channels/selections, and produces independent objects | 0.30 |
| Every image-understanding caller and connection test uses `vision` with no LLM fallback | 0.30 |
| Defaults/provider capabilities/UI correctly expose all four channels | 0.20 |
| Focused tests cover success, malformed legacy data, and text-only vision failure | 0.20 |

- **Pass threshold:** 4.0/5.0 weighted score, no critical migration or credential-loss finding.
- **Commands:** `npx tsx tests/unit-vision-config.ts` and `npm run build`.

### Step 2: Persist And Produce The Project Visual Bible [DONE]

**Goal:** Establish a file-backed, versioned project visual baseline from either supported source and make its lifecycle deterministic.

**Subtasks**

- Implement visual-bible load/save/path helpers and add `visualBible` to the project store restore/watch lifecycle. Treat missing/corrupt manifests as no bible and surface a warning; never erase recoverable image files.
- Implement `analyzeReferenceStyle(visionCfg, image)` using multimodal chat and `analyzeNovelStyle(llmCfg, novel)` using enabled chapter text. Whole-novel analysis must process chapters in bounded chunks, extract era/genre/mood/palette/medium/line/color/lighting/camera traits, and synthesize one concise English image-prompt suffix; do not send an unbounded full novel in one request.
- Implement draft creation for exactly one `StyleSource`. Reference-image mode copies the upload into canonical storage, analyzes it through vision, and uses it directly as the style reference. Novel-analysis mode uses the text LLM for the description and image API to create the no-character style sample.
- Generate one initial three-view per extracted main character. Use the character card prompt and optional uploaded character source reference; save the result to the canonical character path and set its character approval false until reviewed.
- Provide service operations to rewrite/edit style description, regenerate the novel-mode sample, regenerate one character sheet, mark individual character sheets accepted, approve the entire bible, and compute/refresh the fingerprint.
- Implement explicit cache/map invalidation helpers matching the global and per-character rules above. Operations must update revision/status before they can be reused by generation.
- Migrate legacy `CharacterCard.referenceImage` payloads to file-backed character references on the first successful visual-bible save.
- Add persistence/service tests using a temporary project directory and mocked LLM/vision/image responses. Include round-trip restore, corrupt/missing file handling, both source modes, deterministic fingerprinting, and scoped invalidation.

**Expected Outputs**

- `ProjectVisualBible` persistence and lifecycle services, integrated with project state.
- Both style-analysis flows, canonical artifact files, and first-pass three-view generation services.
- Focused visual-bible persistence/service tests with no live API dependency.

**Verification**

- **Level:** Panel (high impact: durable project state and destructive invalidation boundaries).
- **Artifacts:** visual-bible types/service, persistence/store integration, temporary-directory fixtures, test output.
- **Rubric:**

| Criterion | Weight |
| --- | ---: |
| Manifest and image storage round-trip without base64 in JSON; legacy migration is idempotent | 0.25 |
| Both source modes produce the correct description/reference behavior with bounded novel analysis | 0.25 |
| Fingerprint, approval transitions, and missing/corrupt artifact handling are deterministic | 0.25 |
| Global versus character-scoped invalidation removes only the intended caches/map entries | 0.25 |

- **Pass threshold:** 4.0/5.0 weighted score, no data-loss or cross-character invalidation finding.
- **Commands:** `npx tsx tests/unit-visual-bible.ts`, `npx tsx tests/unit-persist.ts`, and `npm run build`.

### Step 3: Route Reference Capabilities And Fix Three-View Regeneration [DONE]

**Goal:** Guarantee that approved references reach compatible image models in a stable role order and that regeneration affects only the requested character.

**Subtasks**

- Replace single-reference image options with `references: ImageReference[]` across `ImageTask`, `generateImage`, the universal adapter context, generation, self-check, and regeneration. Keep a narrow legacy adapter only where needed during migration; new task construction must use the array.
- Resolve `ImageModelCapabilities` from a known-model table first and explicit `ApiConfig.extra.imageCapabilities` for custom models. Include `Qwen/Qwen-Image-Edit-2509 = { maxReferenceImages: 3, supportsSeed: true, supportsImageEdit: true, referenceEncoding: "data-url" }`. Unknown models default to zero reference images unless explicitly configured; capability inference must not overclaim support.
- Expose custom image capability fields in ConfigPage: reference-image count (0-3), image-edit support, seed support, and raw-base64/data-url encoding. Validate contradictory settings (`maxReferenceImages > 0` requires image edit).
- Route references in deterministic priority/order: character tasks use identity (source upload or approved three-view), then global style, then structure; background/CG use global style, then optional structure; item tasks use item identity/material when available, then global style. Deduplicate identical source paths/content before applying the model limit.
- For Qwen Image Edit map the ordered data URLs to `image`, `image2`, and `image3`. Extend universal-template variables for raw base64 and data URL forms so existing local IP-Adapter integrations retain raw base64. Include MIME in data URLs and do not double-prefix an existing data URL.
- Before an API request, compare required references with capabilities. Throw typed `REFERENCE_UNSUPPORTED` when no required reference can be supplied or a required role would be discarded; throw `REFERENCE_MISSING` when a declared path cannot be read. Record the failed task and do not retry as text-to-image.
- Change local image service health/capability handling so failed IP-Adapter initialization reports `referenceImageReady: false`; required-reference tasks must stop before generation.
- Fix `regenerateCharacterThreeView` to select `t.kind === "threeview" && t.id === `${charId}_threeview`` plus only that character's dependent figure/action tasks. Force task construction with `threeView: true` for this explicit operation regardless of `characterPoses`/batch options. Preserve execution order: three-view, default figure, expressions, then actions.
- Use the approved visual-bible style description in every image prompt. Use its style reference rather than creating a separate implicit anchor task; retain compatibility reading for old `anchor_style.png` projects but do not generate a competing anchor after a visual bible is approved.
- Add contract tests for Qwen `image/image2/image3`, raw-base64 local adapters, one-reference routing, deduplication, unsupported/missing errors, no silent fallback, health reporting, and the exact single-character regeneration predicate/order.

**Expected Outputs**

- Capability-aware multi-reference image generation and adapter variables.
- Typed, user-visible reference errors with no downgrade path.
- Correct and option-independent single-character three-view regeneration.
- Expanded image task/adapter/regeneration tests.

**Verification**

- **Level:** Panel (critical: provider wire contracts and consistency guarantees).
- **Artifacts:** reference/capability types, adapter request builders/templates, image task runner/regeneration code, contract and regression test output.
- **Rubric:**

| Criterion | Weight |
| --- | ---: |
| Role priority, model limits, deduplication, and required-reference validation are deterministic | 0.30 |
| Qwen data-URL and local raw-base64 request contracts match their configured wire shapes | 0.25 |
| Unsupported/missing references and IP-Adapter failure can never silently become text-to-image | 0.25 |
| One-character three-view regeneration is correctly scoped and dependency ordered with poses disabled | 0.20 |

- **Pass threshold:** 4.2/5.0 weighted score, zero silent-fallback or cross-character-regeneration finding.
- **Commands:** `npx tsx tests/unit-image-references.ts`, `npx tsx tests/unit-tasks.ts`, and `npm run build`.

### Step 4: Add The GeneratePage Approval Workflow And Integration Tests [DONE]

**Goal:** Make visual-bible creation, review, correction, approval, and resumed generation a complete user workflow.

**Subtasks**

- Add a GeneratePage visual-bible section/modal that appears when images are enabled and the bible is missing, draft, or stale. Use the existing restrained desktop UI patterns; avoid nested cards and keep previews usable at narrower window widths.
- Let the user select exactly one style source. Reference-image mode provides upload/replace plus vision-analysis status. Novel-analysis mode provides whole-book analysis plus style-sample generation status. Display actionable errors beside the operation that failed.
- Show an editable style description, the current style reference/sample preview, and one row per extracted main character with source-reference indicator, three-view preview, approval state, and a regenerate control. Support style rewrite/edit, sample regeneration, individual three-view regeneration, and retry after failure.
- Keep final approval disabled until the service validator confirms all required files and per-character approvals. On approval, persist first, then resume image/voice/assemble stages. A failed save must not mark the in-memory bible approved.
- Integrate the pipeline gate for full runs and stage reruns. Text-only stages continue normally; attempts to select the image stage with a stale/unapproved bible navigate to the approval surface with `VISUAL_BIBLE_APPROVAL_REQUIRED` instead of partially running images.
- Use `activeConfig("vision")` for visual analysis/self-check and pass the approved bible into pipeline/regeneration contexts. Present `REFERENCE_UNSUPPORTED`, `REFERENCE_MISSING`, and vision configuration failures with the model/channel and suggested settings, while retaining current progress/log behavior.
- Make style and character invalidation immediately visible in the asset view: stale assets cannot be selected as valid references, unaffected characters/backgrounds remain available after a character-only change, and the regenerate-three-view button works when the batch pose option is off.
- Add component/integration coverage with mocked Tauri and API calls for both source modes, approve/resume, reload restore, stale blocking, per-character regeneration, missing/unsupported errors, and cancellation/retry. Run a real-browser acceptance pass at approximately 1280x800 and 900x700; check console errors, overflow, disabled states, progress, and image previews.

**Expected Outputs**

- A complete visual-bible approval experience integrated into GeneratePage and the pipeline resume flow.
- User-facing failure states for vision and reference capability problems.
- Automated integration coverage and recorded browser acceptance evidence.

**Verification**

- **Level:** Panel (high impact: primary user workflow and generation gate).
- **Artifacts:** GeneratePage/store/pipeline integration, UI/integration tests, desktop/narrow screenshots, browser console report, full build/test output.
- **Rubric:**

| Criterion | Weight |
| --- | ---: |
| Both source workflows reach a reviewable draft and enforce complete approval before images | 0.30 |
| Approval persists before resume; stale/missing state blocks without partial image output | 0.25 |
| Per-item regeneration, error/retry/cancel states, and scoped invalidation are usable and accurate | 0.25 |
| Browser evidence shows readable, non-overlapping UI with no console/runtime errors | 0.20 |

- **Pass threshold:** 4.0/5.0 weighted score, no bypass of the approval gate.
- **Commands:** project visual-bible integration test(s), `npx tsx tests/e2e-demo.ts`, `npm run build`, plus real-browser acceptance against the Vite dev server.

## Test Matrix

| Area | Required Scenarios |
| --- | --- |
| Configuration | Fresh four-channel defaults; v1 migration; reload idempotency; malformed/partial presets; independent edits; vision success/error |
| Persistence | Both style sources; manifest round trip; no base64 JSON; legacy character reference migration; missing/corrupt artifact; deterministic fingerprint |
| Lifecycle | Draft -> approved; approved -> stale; global invalidation; character-only invalidation; approval validation; failed save |
| Reference routing | 3/1/0-reference models; identity/style/structure ordering; duplicate references; raw/data URL; missing file; unknown/custom capabilities |
| Regeneration | One target character only; dependency order; poses off; other characters and scene assets unchanged |
| Workflow | Text stages before approval; image gate; approve/resume; restart/restore; self-check uses vision; retry/cancel and actionable errors |

All API-dependent automated tests must use deterministic mocked fetch/adapters. Live provider calls are manual smoke tests only and must not be required for CI or local completion.

## Definition Of Done

- All ten acceptance criteria are implemented and traceable to automated tests or the browser acceptance record.
- The four sequential step verification gates meet their thresholds and every rubric table sums to `1.0`.
- `npm run build` succeeds, existing unit scripts affected by the change still pass, and no test requires external network credentials.
- Existing configuration/project data loads without loss; repeated loads do not duplicate vision configs or rewrite references.
- Project JSON contains no newly persisted image base64, and all canonical visual-bible files remain under `.novel2vn/visual-bible/`.
- No image-understanding operation uses the text LLM, and no required-reference failure can silently issue a text-to-image request.
- Browser acceptance confirms the review workflow at desktop and narrow desktop sizes with no overlap, clipped controls, blank previews, or console errors.
- Relevant user documentation is updated to describe the fourth API channel, visual-bible approval requirement, capability settings, storage location, and recovery steps for missing references.
- Unrelated dirty-worktree changes remain intact; only feature-relevant files/tests/docs are modified.
