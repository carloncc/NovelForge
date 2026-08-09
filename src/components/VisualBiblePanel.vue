<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, scheduleSave } from "../stores/project";
import { activeConfig } from "../stores/config";
import { tauri, isTauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { configIsUsable } from "../api/providers";
import { VisionApiError } from "../api/openaiCompatible";
import { useAssetThumbs } from "../composables/useAssetThumbs";
import LazyThumb from "./LazyThumb.vue";
import AssetPreview from "./AssetPreview.vue";
import type { CharacterCard, ProjectVisualBible, StyleSource } from "../core/types";
import {
  acceptCharacterSheet,
  approveVisualBible,
  computeProjectVisualBibleFingerprint,
  createVisualBibleDraft,
  refreshVisualBibleFingerprint,
  regenerateCharacterSheet,
  regenerateStyleSample,
  replaceCharacterReference,
  replaceStyleReference,
  rewriteStyleDescription,
  updateStyleDescription,
  validateVisualBibleForApproval,
  visualBiblePath,
} from "../core/visualBible";
import type { VisualBibleImageInput } from "../core/visualBible";
import { visualBibleErrorMessage } from "../core/visualBibleWorkflow";

interface PendingImage {
  dataB64: string;
  mime: string;
  dataUrl: string;
}

const emit = defineEmits<{
  (e: "approve"): void;
  (e: "changed"): void;
  (e: "prepare"): void;
}>();

const { mimeOf } = useAssetThumbs();

const styleSource = ref<StyleSource>("novel_analysis");
const styleFileInput = ref<HTMLInputElement | null>(null);
const charFileInput = ref<HTMLInputElement | null>(null);
const charUploadTarget = ref("");
const pendingStyleImage = ref<PendingImage | null>(null);
const pendingCharImages = ref<Record<string, PendingImage>>({});
const styleDescriptionText = ref("");
const rewriteInstruction = ref("");
const creating = ref(false);
const busyKey = ref("");
const createError = ref("");
const styleError = ref("");
const approvalError = ref("");
const charErrors = ref<Record<string, string>>({});
const approvalErrors = ref<string[]>([]);
const preview = ref<{ path: string; label: string } | null>(null);

const bible = computed<ProjectVisualBible | null>(() => projectState.visualBible);
const characters = computed<CharacterCard[]>(() => projectState.lastResult?.cards.characters ?? []);
const outputDir = computed(() => projectState.outputDir);

const bibleNeedsReview = computed(() => !bible.value || bible.value.status !== "approved");
const hasCards = computed(() => characters.value.length > 0);
const stylePreviewSrc = computed(() => pendingStyleImage.value?.dataUrl || (bible.value ? vbPath(bible.value.styleReferencePath) : ""));
const canCreateDraft = computed(() => {
  if (creating.value || !hasCards.value || !outputDir.value) return false;
  if (styleSource.value === "reference_image") return !!pendingStyleImage.value;
  return true;
});
const canApprove = computed(() => {
  return !!bible.value
    && bibleNeedsReview.value
    && approvalErrors.value.length === 0
    && !creating.value
    && !busyKey.value;
});

const bibleStatusLabel = computed(() => {
  if (!bible.value) return "未创建";
  if (bible.value.status === "approved") return "已批准";
  if (bible.value.status === "stale") return "已失效，需重新确认";
  return "草稿";
});

const resumeHint = computed(() => {
  if (!bible.value || bible.value.status === "approved") return "";
  return "批准后将续跑已勾选的图像及后续阶段";
});

function openPreview(path: string, label: string): void {
  if (path) preview.value = { path, label };
}

function vbPath(storedPath: string | undefined): string {
  if (!storedPath || !outputDir.value) return "";
  try {
    return visualBiblePath(outputDir.value, storedPath);
  } catch {
    return "";
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function imageInput(dataB64: string, mime: string): VisualBibleImageInput {
  return { dataB64, mime };
}

async function pickStyleFile(): Promise<void> {
  if (!isTauri()) {
    styleFileInput.value?.click();
    return;
  }
  const picked = await open({
    multiple: false,
    filters: [{ name: "参考图", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!picked || typeof picked !== "string") return;
  try {
    const dataB64 = await tauri.readFileBase64(picked);
    const mime = mimeOf(picked);
    pendingStyleImage.value = { dataB64, mime, dataUrl: `data:${mime};base64,${dataB64}` };
    styleError.value = "";
  } catch (e) {
    styleError.value = `读取参考图失败：${errMsg(e)}`;
  }
}

async function onStyleFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const dataB64 = await fileToBase64(file);
  const mime = file.type || "image/png";
  pendingStyleImage.value = { dataB64, mime, dataUrl: `data:${mime};base64,${dataB64}` };
  styleError.value = "";
}

async function pickCharacterFile(characterId: string): Promise<void> {
  charUploadTarget.value = characterId;
  if (!isTauri()) {
    charFileInput.value?.click();
    return;
  }
  const picked = await open({
    multiple: false,
    filters: [{ name: "角色参考图", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!picked || typeof picked !== "string") return;
  try {
    const dataB64 = await tauri.readFileBase64(picked);
    const mime = mimeOf(picked);
    pendingCharImages.value[characterId] = { dataB64, mime, dataUrl: `data:${mime};base64,${dataB64}` };
    charErrors.value[characterId] = "";
  } catch (e) {
    charErrors.value[characterId] = `读取参考图失败：${errMsg(e)}`;
  }
}

async function onCharFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const characterId = charUploadTarget.value;
  if (!file || !characterId) return;
  const dataB64 = await fileToBase64(file);
  const mime = file.type || "image/png";
  pendingCharImages.value[characterId] = { dataB64, mime, dataUrl: `data:${mime};base64,${dataB64}` };
  charErrors.value[characterId] = "";
}

async function refreshFingerprint(): Promise<void> {
  const current = bible.value;
  const novel = projectState.novel;
  const cards = projectState.lastResult?.cards;
  if (!current || !novel || !cards || !outputDir.value) return;
  const fingerprint = await computeProjectVisualBibleFingerprint(outputDir.value, current, novel, cards.characters);
  await refreshVisualBibleFingerprint(outputDir.value, current, fingerprint, cards.characters, true);
}

async function refreshApprovalValidation(): Promise<void> {
  const current = bible.value;
  if (!current || !characters.value.length || !outputDir.value) {
    approvalErrors.value = [];
    return;
  }
  const result = await validateVisualBibleForApproval(
    outputDir.value,
    current,
    characters.value.map((character) => character.id),
  );
  approvalErrors.value = result.errors;
}

watch(
  () => [bible.value, characters.value.map((character) => character.id).join(",")],
  () => {
    styleDescriptionText.value = bible.value?.styleDescription ?? "";
    void refreshApprovalValidation();
  },
  { deep: true, immediate: true },
);

watch(
  () => bible.value?.styleDescription,
  (value) => {
    if (typeof value === "string") styleDescriptionText.value = value;
  },
);

async function afterMutation(): Promise<void> {
  scheduleSave();
  emit("changed");
}

async function createDraft(): Promise<void> {
  createError.value = "";
  const cards = projectState.lastResult?.cards;
  const novel = projectState.novel;
  if (!cards || !novel || !outputDir.value) {
    createError.value = "请先运行文本阶段，生成角色卡片";
    return;
  }
  const imageCfg = activeConfig("image");
  if (!imageCfg?.apiKey) {
    createError.value = "尚未配置图像生成 API，无法生成视觉圣经参考图";
    return;
  }
  if (styleSource.value === "reference_image" && !pendingStyleImage.value) {
    createError.value = "请先选择一张风格参考图";
    return;
  }
  if (styleSource.value === "novel_analysis" && !activeConfig("llm")?.apiKey) {
    createError.value = "整本小说风格分析需要配置文本 LLM API";
    return;
  }
  if (styleSource.value === "reference_image" && !configIsUsable(activeConfig("vision"), "vision")) {
    createError.value = "参考图模式需要配置可用的图片识别（vision）API";
    return;
  }

  const characterReferences: Record<string, VisualBibleImageInput> = {};
  for (const [characterId, pending] of Object.entries(pendingCharImages.value)) {
    characterReferences[characterId] = imageInput(pending.dataB64, pending.mime);
  }
  const base = {
    outputDir: outputDir.value,
    novel,
    cards,
    imageCfg,
    characterReferences,
  };

  creating.value = true;
  try {
    const created = styleSource.value === "reference_image"
      ? await createVisualBibleDraft({
        ...base,
        styleSource: "reference_image",
        visionCfg: activeConfig("vision")!,
        styleReference: imageInput(pendingStyleImage.value!.dataB64, pendingStyleImage.value!.mime),
      })
      : await createVisualBibleDraft({
        ...base,
        styleSource: "novel_analysis",
        llmCfg: activeConfig("llm")!,
      });
    projectState.visualBible = created;
    pendingStyleImage.value = null;
    pendingCharImages.value = {};
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "视觉圣经草稿已生成，请逐项确认后批准", level: "success", at: Date.now() });
  } catch (e) {
    createError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    creating.value = false;
  }
}

async function saveStyleDescription(): Promise<void> {
  const current = bible.value;
  const description = styleDescriptionText.value.trim();
  if (!current || !outputDir.value) return;
  if (!description) {
    styleError.value = "风格描述不能为空";
    return;
  }
  busyKey.value = "style-save";
  styleError.value = "";
  try {
    await updateStyleDescription(outputDir.value, current, description);
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "风格描述已更新，角色需重新确认", level: "info", at: Date.now() });
  } catch (e) {
    styleError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function rewriteStyle(): Promise<void> {
  const current = bible.value;
  const llmCfg = activeConfig("llm");
  if (!current || !outputDir.value) return;
  if (!llmCfg?.apiKey) {
    styleError.value = "AI 重写风格需要配置文本 LLM API";
    return;
  }
  busyKey.value = "style-rewrite";
  styleError.value = "";
  try {
    await rewriteStyleDescription(outputDir.value, current, {
      llmCfg,
      instruction: rewriteInstruction.value.trim() || undefined,
    });
    styleDescriptionText.value = current.styleDescription;
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "风格描述已由 AI 重写", level: "success", at: Date.now() });
  } catch (e) {
    styleError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function regenerateSample(): Promise<void> {
  const current = bible.value;
  const imageCfg = activeConfig("image");
  if (!current || !outputDir.value) return;
  if (current.styleSource !== "novel_analysis") {
    styleError.value = "上传参考图模式不能重新生成示例图，请替换参考图";
    return;
  }
  if (!imageCfg?.apiKey) {
    styleError.value = "重新生成风格示例需要配置图像生成 API";
    return;
  }
  busyKey.value = "style-sample";
  styleError.value = "";
  try {
    await regenerateStyleSample(outputDir.value, current, imageCfg);
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "风格示例图已重新生成，需重新确认角色", level: "success", at: Date.now() });
  } catch (e) {
    styleError.value = visualBibleErrorMessage(e, {
      imageModel: imageCfg.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function replaceStyleFromUpload(): Promise<void> {
  const current = bible.value;
  const visionCfg = activeConfig("vision");
  if (!current || !outputDir.value || !pendingStyleImage.value) return;
  if (!configIsUsable(visionCfg, "vision")) {
    styleError.value = "替换参考图需要配置可用的图片识别（vision）API";
    return;
  }
  busyKey.value = "style-replace";
  styleError.value = "";
  try {
    await replaceStyleReference(outputDir.value, current, {
      visionCfg,
      image: imageInput(pendingStyleImage.value.dataB64, pendingStyleImage.value.mime),
    });
    pendingStyleImage.value = null;
    styleDescriptionText.value = current.styleDescription;
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "全局风格参考图已替换，需重新确认", level: "success", at: Date.now() });
  } catch (e) {
    styleError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: visionCfg.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function replaceCharacterFromUpload(characterId: string): Promise<void> {
  const current = bible.value;
  const pending = pendingCharImages.value[characterId];
  const character = characters.value.find((candidate) => candidate.id === characterId);
  if (!current || !outputDir.value || !character || !pending) return;
  busyKey.value = `char-ref:${characterId}`;
  charErrors.value[characterId] = "";
  try {
    await replaceCharacterReference(
      outputDir.value,
      current,
      character,
      imageInput(pending.dataB64, pending.mime),
    );
    delete pendingCharImages.value[characterId];
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: `角色「${character.name}」参考图已替换，需重新生成三视图`, level: "info", at: Date.now() });
  } catch (e) {
    charErrors.value[characterId] = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function regenerateCharacter(characterId: string): Promise<void> {
  const current = bible.value;
  const imageCfg = activeConfig("image");
  const character = characters.value.find((candidate) => candidate.id === characterId);
  if (!current || !outputDir.value || !character) return;
  if (!imageCfg?.apiKey) {
    charErrors.value[characterId] = "重新生成三视图需要配置图像生成 API";
    return;
  }
  busyKey.value = `char-sheet:${characterId}`;
  charErrors.value[characterId] = "";
  try {
    await regenerateCharacterSheet(outputDir.value, current, { character, imageCfg });
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: `角色「${character.name}」三视图已重新生成`, level: "success", at: Date.now() });
  } catch (e) {
    charErrors.value[characterId] = visualBibleErrorMessage(e, {
      imageModel: imageCfg.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function acceptCharacter(characterId: string): Promise<void> {
  const current = bible.value;
  if (!current || !outputDir.value) return;
  busyKey.value = `char-accept:${characterId}`;
  charErrors.value[characterId] = "";
  try {
    await acceptCharacterSheet(outputDir.value, current, characterId);
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: `角色「${characters.value.find((c) => c.id === characterId)?.name ?? characterId}」三视图已确认`, level: "success", at: Date.now() });
  } catch (e) {
    charErrors.value[characterId] = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

async function approve(): Promise<void> {
  const current = bible.value;
  const novel = projectState.novel;
  if (!current || !novel || !outputDir.value) return;
  busyKey.value = "approve";
  approvalError.value = "";
  try {
    await approveVisualBible(outputDir.value, current, {
      novel,
      characters: characters.value,
    });
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: "视觉圣经已批准，开始续跑剩余阶段", level: "success", at: Date.now() });
    emit("approve");
  } catch (e) {
    approvalError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
  }
}

function characterSheetPath(characterId: string): string {
  const stored = bible.value?.characters[characterId]?.threeViewPath;
  return vbPath(stored);
}

function characterSourcePath(characterId: string): string {
  const stored = bible.value?.characters[characterId]?.sourceReferencePath;
  return vbPath(stored);
}

function characterNeedsRegeneration(characterId: string): boolean {
  const character = bible.value?.characters[characterId];
  if (!character) return true;
  return character.sourceRevision !== character.sheetSourceRevision;
}
</script>

<template>
  <div class="vb-panel">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>视觉圣经确认</h3>
          <p class="vb-sub">图像生成前的统一风格与角色三视图门禁。</p>
        </div>
        <div class="row" style="justify-content: flex-end">
          <span class="tag" :class="bible?.status === 'approved' ? 'ok' : bible?.status === 'stale' ? 'err' : 'warn'">{{ bibleStatusLabel }}</span>
          <span v-if="bibleNeedsReview" class="tag warn">待确认</span>
        </div>
      </div>

      <div v-if="!hasCards" class="vb-empty">
        <p>还没有角色卡片。请先运行文本阶段，生成角色/场景/物品卡。</p>
        <button class="btn" :disabled="creating" @click="emit('prepare')">运行文本阶段</button>
      </div>

      <template v-else-if="!bible">
        <div class="vb-section">
          <div class="vb-section-title">选择风格来源</div>
          <div class="vb-source-grid">
            <label class="vb-source-option" :class="{ active: styleSource === 'reference_image' }">
              <input type="radio" v-model="styleSource" value="reference_image" />
              <span class="vb-source-name">上传参考图</span>
              <span class="vb-source-desc">由图片识别分析，并直接作为全局风格参考</span>
            </label>
            <label class="vb-source-option" :class="{ active: styleSource === 'novel_analysis' }">
              <input type="radio" v-model="styleSource" value="novel_analysis" />
              <span class="vb-source-name">整本小说分析</span>
              <span class="vb-source-desc">文本 LLM 分析全书，再生成无角色风格示例图</span>
            </label>
          </div>

          <div v-if="styleSource === 'reference_image'" class="vb-upload-row">
            <button class="btn secondary small" :disabled="creating" @click="pickStyleFile">
              {{ pendingStyleImage ? "更换参考图" : "选择风格参考图" }}
            </button>
            <span v-if="pendingStyleImage" class="tag ok">已选择</span>
            <img v-if="pendingStyleImage" :src="pendingStyleImage.dataUrl" alt="风格参考图" class="vb-preview-img" />
            <input ref="styleFileInput" type="file" accept="image/png,image/jpeg,image/webp" style="display: none" @change="onStyleFileChange" />
          </div>

          <p v-if="createError" class="vb-error">{{ createError }}</p>
          <div class="vb-actions">
            <button class="btn" :disabled="!canCreateDraft" @click="createDraft">
              <span v-if="creating" class="spinner" />
              {{ creating ? "生成草稿中…" : "创建视觉圣经草稿" }}
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="vb-section">
          <div class="vb-section-title">
            全局风格
            <span class="tag">{{ bible.styleSource === "reference_image" ? "上传参考图" : "整本小说分析" }}</span>
          </div>
          <div class="vb-style-grid">
              <div class="vb-preview-block">
                <div class="vb-preview-label">风格参考 / 示例</div>
                <div class="vb-thumb" :class="{ missing: !stylePreviewSrc }" @click="stylePreviewSrc && openPreview(stylePreviewSrc, '风格参考')">
                  <img v-if="pendingStyleImage" :src="pendingStyleImage.dataUrl" alt="待替换参考" />
                  <LazyThumb v-else-if="stylePreviewSrc" :path="stylePreviewSrc" alt="风格参考" />
                  <span v-else>未生成</span>
                  <span class="thumb-label">点击放大</span>
                </div>
              </div>
            <div class="vb-style-form">
              <label class="field">
                <span>风格描述（可编辑）</span>
                <textarea v-model="styleDescriptionText" rows="4" placeholder="英文风格 prompt 后缀" />
              </label>
              <div class="row">
                <button class="btn small" :disabled="!!busyKey" @click="saveStyleDescription">保存风格</button>
                <button class="btn secondary small" :disabled="!!busyKey" @click="rewriteStyle">AI 重写</button>
                <button
                  v-if="bible.styleSource === 'novel_analysis'"
                  class="btn secondary small"
                  :disabled="!!busyKey"
                  @click="regenerateSample"
                >重新生成示例</button>
              </div>
              <div class="vb-upload-row" v-if="bible.styleSource !== 'novel_analysis' || pendingStyleImage">
                <button class="btn ghost small" :disabled="!!busyKey" @click="pickStyleFile">
                  {{ pendingStyleImage ? "更换已选图片" : "替换参考图" }}
                </button>
                <button v-if="pendingStyleImage" class="btn small" :disabled="!!busyKey" @click="replaceStyleFromUpload">
                  应用替换
                </button>
              </div>
              <input
                v-if="bible.styleSource !== 'novel_analysis' || pendingStyleImage"
                ref="styleFileInput"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style="display: none"
                @change="onStyleFileChange"
              />
              <p v-if="styleError" class="vb-error">{{ styleError }}</p>
            </div>
          </div>
        </div>

        <div class="vb-section">
          <div class="vb-section-title">
            角色三视图
            <span class="vb-section-hint">{{ characters.length }} 个主角色</span>
          </div>
          <div v-for="row in characters" :key="row.id" class="vb-character-row">
            <div class="vb-character-head">
              <div>
                <span class="asset-name">{{ row.name }}</span>
                <span class="tag" :class="bible.characters[row.id]?.approved ? 'ok' : 'warn'">
                  {{ bible.characters[row.id]?.approved ? "已确认" : "待确认" }}
                </span>
                <span v-if="bible.characters[row.id]?.sourceReferencePath" class="tag ok">有参考图</span>
                <span v-if="characterNeedsRegeneration(row.id)" class="tag err">需重新生成</span>
              </div>
              <div class="vb-character-actions">
                <button class="btn small" :disabled="!!busyKey" @click="regenerateCharacter(row.id)">
                  <span v-if="busyKey === `char-sheet:${row.id}`" class="spinner" />
                  重新生成三视图
                </button>
                <button
                  class="btn secondary small"
                  :disabled="!!busyKey || characterNeedsRegeneration(row.id)"
                  @click="acceptCharacter(row.id)"
                >确认此角色</button>
              </div>
            </div>
            <div class="vb-character-body">
              <div class="vb-preview-block">
                <div class="vb-preview-label">上传参考</div>
                <div class="vb-thumb" :class="{ missing: !characterSourcePath(row.id) && !pendingCharImages[row.id] }">
                  <img v-if="pendingCharImages[row.id]" :src="pendingCharImages[row.id].dataUrl" alt="待替换参考" />
                  <LazyThumb v-else-if="characterSourcePath(row.id)" :path="characterSourcePath(row.id)" alt="角色参考" />
                  <span v-else>未上传</span>
                </div>
                <button class="btn ghost small" :disabled="!!busyKey" @click="pickCharacterFile(row.id)">
                  {{ pendingCharImages[row.id] ? "更换已选" : "上传 / 替换" }}
                </button>
                <button
                  v-if="pendingCharImages[row.id]"
                  class="btn small"
                  :disabled="!!busyKey"
                  @click="replaceCharacterFromUpload(row.id)"
                >应用参考图</button>
              </div>
              <div class="vb-preview-block">
                <div class="vb-preview-label">三视图</div>
                <div class="vb-thumb" :class="{ missing: !characterSheetPath(row.id) }" @click="characterSheetPath(row.id) && openPreview(characterSheetPath(row.id), `${row.name} · 三视图`)">
                  <LazyThumb v-if="characterSheetPath(row.id)" :path="characterSheetPath(row.id)" alt="三视图" />
                  <span v-else>未生成</span>
                  <span class="thumb-label">点击放大</span>
                </div>
              </div>
              <div class="vb-character-prompt">
                <span class="vb-preview-label">三视图提示词</span>
                <code>{{ bible.characters[row.id]?.prompt || "暂无" }}</code>
              </div>
            </div>
            <p v-if="charErrors[row.id]" class="vb-error">{{ charErrors[row.id] }}</p>
          </div>
        </div>

        <div class="vb-approval-bar">
          <div>
            <div v-if="approvalErrors.length" class="vb-error">
              {{ approvalErrors.join("；") }}
            </div>
            <p v-else class="vb-sub">{{ resumeHint }}</p>
            <p v-if="approvalError" class="vb-error">{{ approvalError }}</p>
          </div>
          <button class="btn" :disabled="!canApprove" @click="approve">
            <span v-if="busyKey === 'approve'" class="spinner" />
            {{ busyKey === "approve" ? "正在批准…" : "批准并续跑生成" }}
          </button>
        </div>
      </template>
    </div>

    <input ref="charFileInput" type="file" accept="image/png,image/jpeg,image/webp" style="display: none" @change="onCharFileChange" />
  </div>

  <AssetPreview
    v-if="preview"
    :path="preview.path"
    :label="preview.label"
    @close="preview = null"
  />
</template>
