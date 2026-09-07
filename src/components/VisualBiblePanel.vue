<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "../i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, scheduleSave } from "../stores/project";
import { activeConfig, configState } from "../stores/config";
import { concurrencyFor } from "../stores/configMigration";
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
  persistRegeneratedCharacterDescription,
  refreshVisualBibleFingerprint,
  regenerateAllCharacterSheets,
  regenerateCharacterDescription,
  regenerateCharacterSheet,
  regenerateStyleSample,
  replaceCharacterReference,
  replaceStyleReference,
  rewriteStyleDescription,
  syncBibleCharactersWithCards,
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
const createProgress = ref<{ phase: "style" | "threeview"; done: number; total: number } | null>(null);
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
  if (!bible.value) return t("未创建");
  if (bible.value.status === "approved") return t("已批准");
  if (bible.value.status === "stale") return t("已失效，需重新确认");
  return t("草稿");
});

const resumeHint = computed(() => {
  if (!bible.value || bible.value.status === "approved") return "";
  return t("批准后将续跑已勾选的图像及后续阶段");
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
    filters: [{ name: t("参考图"), extensions: ["png", "jpg", "jpeg", "webp"] }],
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
    filters: [{ name: t("角色参考图"), extensions: ["png", "jpg", "jpeg", "webp"] }],
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
    createError.value = t("请先运行文本阶段，生成角色卡片");
    return;
  }
  const imageCfg = activeConfig("image");
  if (!imageCfg?.apiKey) {
    createError.value = t("尚未配置图像生成 API，无法生成视觉圣经参考图");
    return;
  }
  if (styleSource.value === "reference_image" && !pendingStyleImage.value) {
    createError.value = t("请先选择一张风格参考图");
    return;
  }
  if (styleSource.value === "novel_analysis" && !activeConfig("llm")?.apiKey) {
    createError.value = t("整本小说风格分析需要配置文本 LLM API");
    return;
  }
  if (styleSource.value === "reference_image" && !configIsUsable(activeConfig("vision"), "vision")) {
    createError.value = t("参考图模式需要配置可用的图片识别（vision）API");
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
    onProgress: (phase: "style" | "threeview", done: number, total: number) => {
      createProgress.value = { phase, done, total };
    },
  };

  creating.value = true;
  createProgress.value = null;
  pushLog({
    step: "视觉圣经",
    message: `创建草稿开始（风格来源：${styleSource.value === "reference_image" ? "参考图" : "小说分析"}；${cards.characters.length} 个角色${Object.keys(pendingCharImages.value).length ? `，其中 ${Object.keys(pendingCharImages.value).length} 个带上传参考图` : ""}）`,
    level: "info",
    at: Date.now(),
  });
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
    pushLog({ step: "视觉圣经", message: `视觉圣经草稿已生成（风格分析覆盖全书 ${novel.chapters.length} 章，${cards.characters.length} 个角色全部建档），请逐项确认后批准`, level: "success", at: Date.now() });
  } catch (e) {
    createError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    creating.value = false;
    createProgress.value = null;
  }
}

async function saveStyleDescription(): Promise<void> {
  const current = bible.value;
  const description = styleDescriptionText.value.trim();
  if (!current || !outputDir.value) return;
  if (!description) {
    styleError.value = t("风格描述不能为空");
    return;
  }
  busyKey.value = "style-save";
  styleError.value = "";
  try {
    await updateStyleDescription(outputDir.value, current, description);
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: t("风格描述已更新，角色需重新确认"), level: "info", at: Date.now() });
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
    styleError.value = t("AI 重写风格需要配置文本 LLM API");
    return;
  }
  busyKey.value = "style-rewrite";
  styleError.value = "";
  if (!window.confirm("AI 重写将覆盖当前风格描述（含你的手改）。继续吗？")) {
    busyKey.value = "";
    return;
  }
  try {
    await rewriteStyleDescription(outputDir.value, current, {
      llmCfg,
      instruction: rewriteInstruction.value.trim() || undefined,
    });
    styleDescriptionText.value = current.styleDescription;
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: t("风格描述已由 AI 重写"), level: "success", at: Date.now() });
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
    styleError.value = t("上传参考图模式不能重新生成示例图，请替换参考图");
    return;
  }
  if (!imageCfg?.apiKey) {
    styleError.value = t("重新生成风格示例需要配置图像生成 API");
    return;
  }
  busyKey.value = "style-sample";
  styleError.value = "";
  if (!window.confirm("重新生成风格示例图将覆盖旧图（角色需重新确认），并产生 1 张图片费用。继续吗？")) {
    busyKey.value = "";
    return;
  }
  try {
    await regenerateStyleSample(outputDir.value, current, imageCfg);
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({ step: "视觉圣经", message: t("风格示例图已重新生成，需重新确认角色"), level: "success", at: Date.now() });
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
    styleError.value = t("替换参考图需要配置可用的图片识别（vision）API");
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
    pushLog({ step: "视觉圣经", message: t("全局风格参考图已替换，需重新确认"), level: "success", at: Date.now() });
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
    charErrors.value[characterId] = t("重新生成三视图需要配置图像生成 API");
    return;
  }
  busyKey.value = `char-sheet:${characterId}`;
  charErrors.value[characterId] = "";
  if (!window.confirm(`重新生成「${character.name}」的三视图？将覆盖当前版本（已确认的打回待确认），并产生 1 张图片费用。`)) {
    busyKey.value = "";
    return;
  }
  pushLog({ step: "视觉圣经", message: `角色「${character.name}」三视图重生成开始…`, level: "info", at: Date.now() });
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

/**
 * 重新生成角色描述（imagePrompt / threeViewPrompt），强制绿幕背景。
 * 适用：旧版 LLM 提取时把背景写死成"plain solid <色> background"，与绿幕后缀冲突，
 *       AI 按旧色画底色，导致抠图困难。点击后会让 LLM 重新生成描述，并提示
 *       「需重新生成三视图/立绘」以让图像按新绿幕 prompt 出来。
 */
async function regenerateCharacterDesc(characterId: string): Promise<void> {
  const current = bible.value;
  const character = characters.value.find((candidate) => candidate.id === characterId);
  if (!current || !outputDir.value || !character) return;
  const visionCfg = activeConfig("vision") ?? activeConfig("llm");
  if (!visionCfg?.apiKey) {
    charErrors.value[characterId] = t("重新生成角色描述需要配置视觉或文本 API");
    return;
  }
  busyKey.value = `char-desc:${characterId}`;
  charErrors.value[characterId] = "";
  pushLog({ step: "视觉圣经", message: `角色「${character.name}」描述重生成开始…`, level: "info", at: Date.now() });
  try {
    const { imagePrompt, threeViewPrompt } = await regenerateCharacterDescription(visionCfg, character);
    const { card: updatedCard } = await persistRegeneratedCharacterDescription(
      outputDir.value,
      current,
      characterId,
      character,
      imagePrompt,
      threeViewPrompt,
    );
    // 同步到 projectState.lastResult.cards.characters —— 否则 buildImageTasks 还会用旧 prompt
    const lastResult = projectState.lastResult;
    if (lastResult?.cards?.characters) {
      const idx = lastResult.cards.characters.findIndex((c) => c.id === characterId);
      if (idx >= 0) {
        lastResult.cards.characters.splice(idx, 1, updatedCard);
      }
    }
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({
      step: "视觉圣经",
      message: `角色「${character.name}」描述已重新生成（强制绿幕），需重新生成三视图`,
      level: "success",
      at: Date.now(),
    });
  } catch (e) {
    charErrors.value[characterId] = visualBibleErrorMessage(e, {
      visionModel: visionCfg.model,
    });
  } finally {
    busyKey.value = "";
  }
}

/** 同步当前卡片：圣经条目按老 id 存、重提换 id 后全员 missing 时，一键按当前卡片补建＋移除多余条目 */
async function syncCharactersWithCards(): Promise<void> {
  const current = bible.value;
  const cards = projectState.lastResult?.cards;
  if (!current || !outputDir.value || !cards?.characters.length) return;
  const imageCfg = activeConfig("image");
  const missing = cards.characters.filter((c) => !current.characters[c.id]);
  const cardIds = new Set(cards.characters.map((c) => c.id));
  const extra = Object.keys(current.characters).filter((id) => !cardIds.has(id));
  if (!missing.length && !extra.length) {
    pushLog({ step: "视觉圣经", message: "圣经条目与当前卡片已同步，无需操作", level: "success", at: Date.now() });
    return;
  }
  // 只有需要补建三视图（调图像 API）时才要求图像配置；仅移除多余条目时不需要
  if (missing.length && !imageCfg?.apiKey) {
    approvalError.value = t("同步需要配置图像生成 API（为缺失角色生成三视图）");
    return;
  }
  if (!window.confirm(
    `圣经与当前卡片不同步：缺失 ${missing.length} 个角色条目（${missing.slice(0, 5).map((c) => c.name || c.id).join("、")}${missing.length > 5 ? "…" : ""}）`
    + `${extra.length ? `，多余 ${extra.length} 个旧条目（${extra.slice(0, 5).join("、")}${extra.length > 5 ? "…" : ""}）` : ""}。`
    + "将按当前卡片补建三视图（调用图像 API）、移除多余条目，已确认项不受影响。继续吗？",
  )) return;
  busyKey.value = "sync-cards";
  approvalError.value = "";
  pushLog({
    step: "视觉圣经",
    message: `同步开始：缺失 ${missing.length} 个条目待补建${extra.length ? `，多余 ${extra.length} 个待移除` : ""}…`,
    level: "info",
    at: Date.now(),
  });
  try {
    const refs: Record<string, VisualBibleImageInput> = {};
    for (const [id, pending] of Object.entries(pendingCharImages.value)) {
      refs[id] = imageInput(pending.dataB64, pending.mime);
    }
    const r = await syncBibleCharactersWithCards(outputDir.value, current, {
      characters: cards.characters,
      imageCfg,
      characterReferences: refs,
      onProgress: (done, total) => {
        createProgress.value = { phase: "threeview", done, total };
      },
    });
    await refreshFingerprint();
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({
      step: "视觉圣经",
      message: `同步完成：补建 ${r.added.length} 个三视图条目${r.adopted.length ? `（其中 ${r.adopted.length} 个复用孤儿文件免生成：${r.adopted.join("、")}）` : ""}，移除多余 ${r.removed.length} 个`
        + `${r.failed.length ? `，失败 ${r.failed.length} 个（${r.failed.map((f) => `${f.name}：${f.reason.slice(0, 60)}`).join("；")}）` : ""}`
        + "；被移除 id 的旧人物图孤儿请用素材页「清理无效素材」收尾",
      level: r.failed.length ? "warn" : "success",
      at: Date.now(),
    });
    if (r.failed.length) {
      approvalError.value = r.failed.map((f) => `${f.name}：${f.reason}`).join("；");
    }
  } catch (e) {
    approvalError.value = visualBibleErrorMessage(e, {
      imageModel: activeConfig("image")?.model,
      visionModel: activeConfig("vision")?.model,
    });
  } finally {
    busyKey.value = "";
    createProgress.value = null;
  }
}

/** 全局重新生成＝全量重建：逐个角色「LLM 重写描述 ＋ 重画三视图」，覆盖现有版本并打回待确认，
 * 下游人物图同步作废。_prompt 与图片一起重做_，这正是这个按钮的语义。 */
async function regenerateAllCharacters(): Promise<void> {
  const imageCfg = activeConfig("image");
  if (!imageCfg?.apiKey) {
    approvalError.value = t("全局重新生成需要配置图像生成 API");
    return;
  }
  const visionCfg = activeConfig("vision") ?? activeConfig("llm");
  if (!visionCfg?.apiKey) {
    approvalError.value = t("全局重新生成需要配置视觉或文本 API（重写角色描述用）");
    return;
  }
  busyKey.value = "regenerate-all";
  approvalError.value = "";
  const n = characters.value.length;
  const limit = Math.max(1, concurrencyFor(imageCfg, "image"));
  if (!window.confirm(`全局重新生成将为 ${n} 个角色重写描述（LLM）＋重画三视图（图像），${limit} 个一组并行，覆盖现有版本并打回待确认，下游人物图同步作废。约 ${n} 次文本调用＋${n} 张图片费用。继续吗？`)) {
    busyKey.value = "";
    return;
  }
  pushLog({
    step: "视觉圣经",
    message: `全局重新生成开始：${n} 个角色重写描述＋重画三视图（${limit} 并发）…`,
    level: "info",
    at: Date.now(),
  });
  createProgress.value = { phase: "threeview", done: 0, total: n };
  try {
    // 批量：API 调用并行、清单一次提交（逐个调单字符接口再并行会互相覆盖丢更新）
    const r = await regenerateAllCharacterSheets(outputDir.value!, bible.value!, {
      characters: characters.value,
      imageCfg,
      visionCfg,
      concurrency: limit,
      onProgress: (done) => {
        createProgress.value = { phase: "threeview", done, total: n };
      },
    });
    // 同步内存卡片（后续管线用新描述）
    const lastResult = projectState.lastResult;
    if (lastResult?.cards?.characters) {
      const updatedById = new Map(r.updatedCards.map((c) => [c.id, c]));
      for (let i = 0; i < lastResult.cards.characters.length; i++) {
        const u = updatedById.get(lastResult.cards.characters[i].id);
        if (u) lastResult.cards.characters.splice(i, 1, u);
      }
    }
    await refreshApprovalValidation();
    await afterMutation();
    pushLog({
      step: "视觉圣经",
      message: `全局重新生成完成：成功 ${r.ok.length} 个${r.failed.length ? `，失败 ${r.failed.length} 个（${r.failed.map((f) => `${f.name}：${f.reason.slice(0, 60)}`).join("；")}）` : ""}（描述＋三视图已全量重做，均待确认）`,
      level: r.failed.length ? "warn" : "success",
      at: Date.now(),
    });
    if (r.failed.length) approvalError.value = r.failed.map((f) => `${f.name}：${f.reason}`).join("；");
  } catch (e) {
    approvalError.value = visualBibleErrorMessage(e, { imageModel: imageCfg.model, visionModel: visionCfg.model });
  } finally {
    busyKey.value = "";
    createProgress.value = null;
  }
}

async function acceptCharacter(characterId: string): Promise<void> {
  const current = bible.value;
  if (!current || !outputDir.value) return;
  busyKey.value = `char-accept:${characterId}`;
  charErrors.value[characterId] = "";
  pushLog({ step: "视觉圣经", message: `角色「${characters.value.find((c) => c.id === characterId)?.name ?? characterId}」确认开始…`, level: "info", at: Date.now() });
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
    pushLog({ step: "视觉圣经", message: t("视觉圣经已批准，开始续跑剩余阶段"), level: "success", at: Date.now() });
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
          <h3>{{ t("视觉圣经确认") }}</h3>
          <p class="vb-sub">{{ t("图像生成前的统一风格与角色三视图门禁。") }}</p>
        </div>
        <div class="row" style="justify-content: flex-end">
          <span class="tag" :class="bible?.status === 'approved' ? 'ok' : bible?.status === 'stale' ? 'err' : 'warn'">{{ bibleStatusLabel }}</span>
          <span v-if="bibleNeedsReview" class="tag warn">{{ t("待确认") }}</span>
        </div>
      </div>

      <div v-if="!hasCards" class="vb-empty">
        <p>{{ t("还没有角色卡片。请先运行文本阶段，生成角色/场景/物品卡。") }}</p>
        <button class="btn" :disabled="creating" @click="emit('prepare')">{{ t("运行文本阶段") }}</button>
      </div>

      <template v-else-if="!bible">
        <div class="vb-section">
          <div class="vb-section-title">{{ t("选择风格来源") }}</div>
          <div class="vb-source-grid">
            <label class="vb-source-option" :class="{ active: styleSource === 'reference_image' }">
              <input type="radio" v-model="styleSource" value="reference_image" />
              <span class="vb-source-name">{{ t("上传参考图") }}</span>
              <span class="vb-source-desc">{{ t("由图片识别分析，并直接作为全局风格参考") }}</span>
            </label>
            <label class="vb-source-option" :class="{ active: styleSource === 'novel_analysis' }">
              <input type="radio" v-model="styleSource" value="novel_analysis" />
              <span class="vb-source-name">{{ t("整本小说分析") }}</span>
              <span class="vb-source-desc">{{ t("文本 LLM 分析全书，再生成无角色风格示例图") }}</span>
            </label>
          </div>

          <div v-if="styleSource === 'reference_image'" class="vb-upload-row">
            <button class="btn secondary small" :disabled="creating" @click="pickStyleFile">
              {{ pendingStyleImage ? t("更换参考图") : t("选择风格参考图") }}
            </button>
            <span v-if="pendingStyleImage" class="tag ok">{{ t("已选择") }}</span>
            <img v-if="pendingStyleImage" :src="pendingStyleImage.dataUrl" :alt="t('风格参考图')" class="vb-preview-img" />
            <input ref="styleFileInput" type="file" accept="image/png,image/jpeg,image/webp" style="display: none" @change="onStyleFileChange" />
          </div>

          <p v-if="createError" class="vb-error">{{ createError }}</p>
          <p v-if="createProgress && createProgress.total > 0" class="vb-progress" style="font-size: 12px; color: var(--text-dim); margin: 4px 0">
            {{ createProgress.phase === "style" ? t("整本小说风格分析") : t("角色三视图生成") }}：{{ createProgress.done }}/{{ createProgress.total }}
          </p>
          <div class="vb-actions">
            <button class="btn" :disabled="!canCreateDraft" @click="createDraft">
              <span v-if="creating" class="spinner" />
              {{ creating ? t("生成草稿中…") : t("创建视觉圣经草稿") }}
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="vb-section">
          <div class="vb-section-title">
            {{ t("全局风格") }}
            <span class="tag">{{ bible.styleSource === "reference_image" ? t("上传参考图") : t("整本小说分析") }}</span>
          </div>
          <div class="vb-style-grid">
              <div class="vb-preview-block">
                <div class="vb-preview-label">{{ t("风格参考 / 示例") }}</div>
                <div class="vb-thumb" :class="{ missing: !stylePreviewSrc }" @click="stylePreviewSrc && openPreview(stylePreviewSrc, t('风格参考'))">
                  <img v-if="pendingStyleImage" :src="pendingStyleImage.dataUrl" :alt="t('待替换参考')" />
                  <LazyThumb v-else-if="stylePreviewSrc" :path="stylePreviewSrc" :alt="t('风格参考')" />
                  <span v-else>{{ t("未生成") }}</span>
                  <span class="thumb-label">{{ t("点击放大") }}</span>
                </div>
              </div>
            <div class="vb-style-form">
              <label class="field">
                <span>{{ t("风格描述（可编辑）") }}</span>
                <textarea v-model="styleDescriptionText" rows="4" :placeholder="t('英文风格 prompt 后缀')" />
              </label>
              <div class="row">
                <button class="btn small" :disabled="!!busyKey" @click="saveStyleDescription">{{ t("保存风格") }}</button>
                <button class="btn secondary small" :disabled="!!busyKey" @click="rewriteStyle">{{ t("AI 重写") }}</button>
                <button
                  v-if="bible.styleSource === 'novel_analysis'"
                  class="btn secondary small"
                  :disabled="!!busyKey"
                  @click="regenerateSample"
                >{{ t("重新生成示例") }}</button>
              </div>
              <div class="vb-upload-row">
                <button class="btn ghost small" :disabled="!!busyKey" @click="pickStyleFile">
                  {{ pendingStyleImage ? t("更换已选图片") : t("上传参考图（替换全局风格）") }}
                </button>
                <button v-if="pendingStyleImage" class="btn small" :disabled="!!busyKey" @click="replaceStyleFromUpload">
                  {{ t("应用替换") }}
                </button>
              </div>
              <input
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
            {{ t("角色三视图") }}
            <span class="vb-section-hint">{{ characters.length }} {{ t("个主角色") }}</span>
            <span class="vb-section-actions">
              <button
                class="btn secondary small"
                :disabled="!!busyKey"
                :title="t('重跑提取后角色 id 变化导致条目对不上时用：按当前卡片补建缺失条目、移除多余条目')"
                @click="syncCharactersWithCards"
              >
                <span v-if="busyKey === 'sync-cards'" class="spinner" />
                {{ t("同步当前卡片") }}
              </button>
              <button class="btn small" :disabled="!!busyKey" :title="t('全部角色：LLM 重写描述＋重画三视图，覆盖现有版本并打回待确认，下游人物图同步作废')" @click="regenerateAllCharacters">
                <span v-if="busyKey === 'regenerate-all'" class="spinner" />
                {{ t("全局重新生成") }}
              </button>
            </span>
          </div>
          <div v-for="row in characters" :key="row.id" class="vb-character-row">
            <div class="vb-character-head">
              <div>
                <span class="asset-name">{{ row.name }}</span>
                <span class="tag" :class="bible.characters[row.id]?.approved ? 'ok' : 'warn'">
                  {{ bible.characters[row.id]?.approved ? t("已确认") : t("待确认") }}
                </span>
                <span v-if="bible.characters[row.id]?.sourceReferencePath" class="tag ok">{{ t("有参考图") }}</span>
                <span v-if="characterNeedsRegeneration(row.id)" class="tag err">{{ t("需重新生成") }}</span>
              </div>
              <div class="vb-character-actions">
                <button
                  class="btn ghost small"
                  :disabled="!!busyKey"
                  :title="t('旧版 LLM 提取时把背景写死成其他颜色时使用，会强制改成纯绿幕')"
                  @click="regenerateCharacterDesc(row.id)"
                >
                  <span v-if="busyKey === `char-desc:${row.id}`" class="spinner" />
                  {{ t("重新生成描述") }}
                </button>
                <button class="btn small" :disabled="!!busyKey" @click="regenerateCharacter(row.id)">
                  <span v-if="busyKey === `char-sheet:${row.id}`" class="spinner" />
                  {{ t("重新生成三视图") }}
                </button>
                <button
                  class="btn secondary small"
                  :disabled="!!busyKey || characterNeedsRegeneration(row.id)"
                  @click="acceptCharacter(row.id)"
                >{{ t("确认此角色") }}</button>
              </div>
            </div>
            <div class="vb-character-body">
              <div class="vb-preview-block">
                <div class="vb-preview-label">{{ t("上传参考") }}</div>
                <div class="vb-thumb" :class="{ missing: !characterSourcePath(row.id) && !pendingCharImages[row.id] }">
                  <img v-if="pendingCharImages[row.id]" :src="pendingCharImages[row.id].dataUrl" :alt="t('待替换参考')" />
                  <LazyThumb v-else-if="characterSourcePath(row.id)" :path="characterSourcePath(row.id)" :alt="t('角色参考')" />
                  <span v-else>{{ t("未上传") }}</span>
                </div>
                <button class="btn ghost small" :disabled="!!busyKey" @click="pickCharacterFile(row.id)">
                  {{ pendingCharImages[row.id] ? t("更换已选") : t("上传 / 替换") }}
                </button>
                <button
                  v-if="pendingCharImages[row.id]"
                  class="btn small"
                  :disabled="!!busyKey"
                  @click="replaceCharacterFromUpload(row.id)"
                >{{ t("应用参考图") }}</button>
              </div>
              <div class="vb-preview-block">
                <div class="vb-preview-label">{{ t("三视图") }}</div>
                <div class="vb-thumb" :class="{ missing: !characterSheetPath(row.id) }" @click="characterSheetPath(row.id) && openPreview(characterSheetPath(row.id), `${row.name} · 三视图`)">
                  <LazyThumb v-if="characterSheetPath(row.id)" :path="characterSheetPath(row.id)" :alt="t('三视图')" />
                  <span v-else>{{ t("未生成") }}</span>
                  <span class="thumb-label">{{ t("点击放大") }}</span>
                </div>
              </div>
              <div class="vb-character-prompt">
                <span class="vb-preview-label">{{ t("三视图提示词") }}</span>
                <code>{{ bible.characters[row.id]?.prompt || t("暂无") }}</code>
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
            {{ busyKey === "approve" ? t("正在批准…") : t("批准并续跑生成") }}
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
