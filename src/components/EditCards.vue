<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { CharacterCard, ExtractionResult, ItemCard, SceneCard } from "../core/types";
import { activeConfig, configState, voiceLibraryFor } from "../stores/config";
import { tauri, isTauri } from "../utils/tauri";
import { vfsWriteFileBase64 } from "../utils/vfsWeb";
import { projectState } from "../stores/project";
import { saveEditedCards } from "../core/cards";
import { open } from "@tauri-apps/plugin-dialog";
import { errMsg } from "../utils/errors";
import { recognizeCharacter } from "../core/recognize";
import { configIsUsable } from "../api/providers";
import { t } from "../i18n";
import { createMiniMaxVoiceProfile, importVoiceProfile } from "../core/voiceProfiles";
import Disclosure from "./Disclosure.vue";

const props = defineProps<{ cards: ExtractionResult }>();
const emit = defineEmits<{ saved: [cards: ExtractionResult] }>();

const local = ref<ExtractionResult>(JSON.parse(JSON.stringify(props.cards)));
const savedMsg = ref("");
const refImgInput = ref<HTMLInputElement | null>(null);
const refImgTarget = ref<CharacterCard | null>(null);
const busy = ref(false);
const openChar = ref<string | null>(null);
const openItem = ref<string | null>(null);
const openScene = ref<string | null>(null);
const charRecognizing = ref<string | null>(null);
const voiceFileInput = ref<HTMLInputElement | null>(null);
const voiceFileTarget = ref<CharacterCard | null>(null);
const voiceBusy = ref<string | null>(null);

async function recognizeChar(c: CharacterCard): Promise<void> {
  if (!c.referenceImage) {
    savedMsg.value = t("请先为该角色设置参考图（从素材库选择或上传）");
    return;
  }
  const cfg = activeConfig("vision");
  if (!configIsUsable(cfg, "vision")) {
    savedMsg.value = t("图片识别 API 未配置或不可用，请先在「API 配置」页配置");
    return;
  }
  charRecognizing.value = c.id;
  savedMsg.value = "";
  try {
    const r = await recognizeCharacter(cfg, c.referenceImage);
    if (r.name) c.name = r.name;
    if (r.appearance) c.appearance = r.appearance;
    if (r.clothing) c.clothing = r.clothing;
    if (r.personality) c.personality = r.personality;
    if (r.voiceDesc) c.voiceDesc = r.voiceDesc;
    if (r.imagePrompt) c.imagePrompt = r.imagePrompt;
    if (r.threeViewPrompt) c.threeViewPrompt = r.threeViewPrompt;
    savedMsg.value = `已根据参考图识别「${c.name}」的设定与提示词，确认后点「保存卡片」`;
  } catch (e) {
    savedMsg.value = `识别失败：${errMsg(e)}`;
  } finally {
    charRecognizing.value = null;
  }
}

// 父组件卡片更新（重新生成后）时同步刷新本地副本
watch(
  () => props.cards,
  () => {
    local.value = JSON.parse(JSON.stringify(props.cards));
    savedMsg.value = "";
  },
);

const voices = computed(() => voiceLibraryFor(activeConfig("tts")));
const voiceProfiles = computed(() => configState.voiceProfiles.filter((profile) => profile.status === "ready"));

async function importCharacterVoice(card: CharacterCard): Promise<void> {
  const config = activeConfig("tts");
  if (!config) { savedMsg.value = t("请先配置 TTS"); return; }
  const voiceId = window.prompt("MiniMax voice_id");
  if (!voiceId?.trim()) return;
  try {
    const profile = await importVoiceProfile({ name: `${card.name} 声音`, configId: config.id, voiceId });
    card.voiceProfileId = profile.id;
    card.voiceName = undefined;
    savedMsg.value = `已绑定克隆声音：${profile.name}`;
  } catch (error) { savedMsg.value = `导入声音失败：${errMsg(error)}`; }
}

async function chooseVoiceReference(card: CharacterCard): Promise<void> {
  if (!isTauri()) { voiceFileTarget.value = card; voiceFileInput.value?.click(); return; }
  const picked = await open({ multiple: false, filters: [{ name: "参考声音", extensions: ["wav", "mp3", "m4a", "ogg", "flac"] }] });
  if (typeof picked === "string") await createVoiceFromPath(card, picked);
}

function audioMime(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", wav: "audio/wav" } as Record<string, string>)[extension ?? ""] || "application/octet-stream";
}

async function createVoiceFromPath(card: CharacterCard, path: string): Promise<void> {
  const config = activeConfig("tts");
  if (!config) { savedMsg.value = t("请先配置 TTS"); return; }
  if (!window.confirm("我确认拥有该参考声音的使用授权，且允许将其上传到所选供应商。")) return;
  voiceBusy.value = card.id;
  try {
    const audioB64 = await tauri.readFileBase64(path);
    const fileName = path.split(/[\\/]/).pop() || "voice.wav";
    const profile = await createMiniMaxVoiceProfile({ name: `${card.name} 声音`, configId: config.id, fileName, mime: audioMime(fileName), audioB64, consent: true });
    card.voiceProfileId = profile.id; card.voiceName = undefined;
    savedMsg.value = `已创建并绑定克隆声音：${profile.name}`;
  } catch (error) { savedMsg.value = `创建声音失败：${errMsg(error)}`; }
  finally { voiceBusy.value = null; }
}

async function onVoiceFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = "";
  const card = voiceFileTarget.value; voiceFileTarget.value = null;
  if (!file || !card) return;
  if (file.size > 12 * 1024 * 1024) { savedMsg.value = "参考音频不能超过 12MB"; return; }
  const audioB64 = await fileToBase64(file);
  const config = activeConfig("tts");
  if (!config || !window.confirm("我确认拥有该参考声音的使用授权，且允许将其上传到所选供应商。")) return;
  voiceBusy.value = card.id;
  try {
    const profile = await createMiniMaxVoiceProfile({ name: `${card.name} 声音`, configId: config.id, fileName: file.name, mime: file.type || "audio/mpeg", audioB64, consent: true });
    card.voiceProfileId = profile.id; card.voiceName = undefined; savedMsg.value = `已创建并绑定克隆声音：${profile.name}`;
  } catch (error) { savedMsg.value = `创建声音失败：${errMsg(error)}`; }
  finally { voiceBusy.value = null; }
}

async function pickReferenceImage(card: CharacterCard): Promise<void> {
  if (!isTauri()) {
    refImgTarget.value = card;
    refImgInput.value?.click();
    return;
  }
  const picked = await open({
    multiple: false,
    filters: [{ name: "参考图", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!picked || typeof picked !== "string") return;
  try {
    const b64 = await tauri.readFileBase64(picked);
    card.referenceImage = b64;
    savedMsg.value = `已为「${card.name}」设置参考图：${picked.split(/[\\/]/).pop()}`;
  } catch (e) {
    savedMsg.value = `读取参考图失败：${errMsg(e)}`;
  }
}

async function onRefImgFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const card = refImgTarget.value;
  if (!file || !card) return;
  try {
    const b64 = await fileToBase64(file);
    const vPath = `/app/materials/ref_${Date.now()}_${file.name}`;
    await vfsWriteFileBase64(vPath, b64);
    card.referenceImage = b64;
    savedMsg.value = `已为「${card.name}」设置参考图`;
  } catch (err) {
    savedMsg.value = `读取参考图失败：${(err as Error).message}`;
  } finally {
    refImgTarget.value = null;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error(t("文件读取失败")));
    reader.readAsDataURL(file);
  });
}

async function save(): Promise<void> {
  busy.value = true;
  savedMsg.value = "";
  try {
    await saveEditedCards(projectState.outputDir, local.value, (m, level = "info") => {
      savedMsg.value = m;
      void level;
    });
    emit("saved", local.value);
  } catch (e) {
    savedMsg.value = `保存失败：${errMsg(e)}`;
  } finally {
    busy.value = false;
  }
}

function reset(): void {
  local.value = JSON.parse(JSON.stringify(props.cards));
  savedMsg.value = t("已恢复为上次生成时的卡片");
}

function addCostume(c: CharacterCard): void {
  if (!c.costumes) c.costumes = [];
  const base = `costume_${c.costumes.length + 1}`;
  c.costumes.push({
    id: base,
    name: t("新服装"),
    prompt: `${c.imagePrompt}, wearing [${t("描述该服装的款式/颜色/材质")}]`,
  });
}

function removeCostume(c: CharacterCard, idx: number): void {
  c.costumes?.splice(idx, 1);
  if (!c.costumes?.length) c.costumes = undefined;
}
</script>

<template>
  <div class="card">
    <input ref="voiceFileInput" type="file" accept="audio/*" style="display: none" @change="onVoiceFile" />
    <div class="flex items-center justify-between mb-3">
      <h3 class="mb-0">{{ t("角色卡编辑（") }}{{ local.characters.length }}{{ t("）") }}</h3>
      <div class="flex gap-2 flex-none">
        <button class="btn small" :disabled="busy" @click="save">{{ t("保存卡片") }}</button>
        <button class="btn secondary small" @click="reset">{{ t("放弃修改") }}</button>
      </div>
    </div>
    <p v-if="savedMsg" class="small mb-2" style="color: var(--ok)">{{ savedMsg }}</p>
    <p class="hint mb-2">
      {{ t("修改角色外貌/服装/音色后保存：剧本与立绘会在下次生成时自动重新生成；背景/CG 保留。") }}
    </p>

    <Disclosure
      v-for="c in local.characters"
      :key="c.id"
      :title="c.name"
      :badge="c.isNpc ? t('NPC') : undefined"
      :subtitle="c.id"
      :open="openChar === c.id"
      @update:open="(v) => (openChar = v ? c.id : null)"
    >
      <div class="row">
        <label class="field"><span>{{ t("姓名") }}</span><input type="text" v-model="c.name" /></label>
        <label class="field"><span>{{ t("主题色") }}</span><input type="text" v-model="c.color" placeholder="#3b5bdb" /></label>
      </div>
      <label class="field"><span>{{ t("外貌") }}</span><input type="text" v-model="c.appearance" /></label>
      <label class="field"><span>{{ t("服装") }}</span><input type="text" v-model="c.clothing" /></label>
      <label class="field"><span>{{ t("性格") }}</span><input type="text" v-model="c.personality" /></label>
      <div class="row">
        <label class="field grow-2">
          <span>{{ t("音色描述") }}</span>
          <input type="text" v-model="c.voiceDesc" />
        </label>
        <label class="field">
          <span>{{ t("TTS 音色（可输入或选择）") }}</span>
          <input type="text" list="novelforge-voices" v-model="c.voiceName" />
          <datalist id="novelforge-voices">
            <option v-for="v in voices" :key="v" :value="v" />
          </datalist>
        </label>
      </div>
      <div class="field">
        <span>克隆声音（可跨项目复用）</span>
        <select v-model="c.voiceProfileId" @change="c.voiceName = undefined">
          <option :value="undefined">使用上方预设音色</option>
          <option v-for="profile in voiceProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}（{{ profile.voiceId }}）</option>
        </select>
        <div class="row mt-2">
          <button class="btn secondary small" :disabled="voiceBusy === c.id" @click="chooseVoiceReference(c)">{{ voiceBusy === c.id ? "创建中..." : "上传参考音频创建" }}</button>
          <button class="btn ghost small" :disabled="voiceBusy === c.id" @click="importCharacterVoice(c)">导入已有 voice_id</button>
        </div>
        <span class="faint small">创建时使用当前 TTS 配置；失败不会自动换成其他人物声音。</span>
      </div>
      <label class="field">
        <span>{{ t("立绘提示词（imagePrompt）") }}</span>
        <textarea v-model="c.imagePrompt" rows="3" />
      </label>
      <div class="field mt-2">
        <span class="flex items-center justify-between">
          <span>{{ t("服装差分（数量不限，按剧情添加）") }}</span>
          <button class="btn ghost small" @click="addCostume(c)">＋ {{ t("添加服装") }}</button>
        </span>
        <div v-for="(ct, ci) in c.costumes || []" :key="ct.id" class="costume-item">
          <div class="row items-center gap-2">
            <input type="text" v-model="ct.name" class="grow small" :placeholder="t('服装名（如 日常服/礼服/战斗服）')" />
            <input type="text" v-model="ct.id" class="small" style="flex: 0.8; font-family: var(--mono)" placeholder="casual" />
            <button class="btn danger small" @click="removeCostume(c, ci)">{{ t("删除") }}</button>
          </div>
          <textarea v-model="ct.prompt" rows="2" class="mt-2 small" :placeholder="t('该服装的英文图像提示词（人物外貌一致 + 服装描述）')" />
        </div>
        <p v-if="!c.costumes?.length" class="faint small mt-2">{{ t("未添加服装差分（可仅用默认服装）") }}</p>
      </div>
      <label class="field">
        <span>{{ t("三视图提示词（threeViewPrompt，可选）") }}</span>
        <textarea v-model="c.threeViewPrompt" rows="3" :placeholder="t('留空则由立绘提示词自动推导')" />
      </label>
      <div class="row">
        <span class="hint">{{ t("参考图（图生图保持一致）：") }}</span>
        <span v-if="c.referenceImage" class="tag ok">{{ t("已设置") }}</span>
        <span v-else class="tag">{{ t("未设置") }}</span>
        <button class="btn secondary small" @click="pickReferenceImage(c)">{{ t("从素材库选择…") }}</button>
        <button v-if="c.referenceImage" class="btn danger small" @click="c.referenceImage = undefined">{{ t("清除") }}</button>
        <input v-if="!isTauri()" ref="refImgInput" type="file" accept="image/*" style="display: none" @change="onRefImgFile" />
      </div>
      <div class="row mt-2">
        <button class="btn small" :disabled="charRecognizing === c.id || !c.referenceImage" @click="recognizeChar(c)">
          <span v-if="charRecognizing === c.id" class="spinner" />
          {{ charRecognizing === c.id ? t("AI 识别中…") : t("用参考图 AI 识别角色（生成描述/提示词）") }}
        </button>
        <span v-if="c.referenceImage" class="faint small">{{ t("AI 会按参考图生成外貌/服装/性格/立绘与三视图提示词，填入上方字段") }}</span>
      </div>
    </Disclosure>
  </div>

  <div class="card">
    <h3 class="mb-3">{{ t("物品卡编辑（") }}{{ local.items.length }}{{ t("）") }}</h3>
    <Disclosure
      v-for="it in local.items"
      :key="it.id"
      :title="it.name"
      :subtitle="it.id"
      :open="openItem === it.id"
      @update:open="(v) => (openItem = v ? it.id : null)"
    >
      <label class="field"><span>{{ t("名称") }}</span><input type="text" v-model="it.name" /></label>
      <label class="field"><span>{{ t("外观") }}</span><input type="text" v-model="it.appearance" /></label>
      <label class="field"><span>{{ t("剧情意义") }}</span><input type="text" v-model="it.note" /></label>
      <label class="field">
        <span>{{ t("物品图提示词") }}</span>
        <textarea v-model="it.imagePrompt" rows="2" />
      </label>
    </Disclosure>
  </div>

  <div class="card">
    <h3 class="mb-3">{{ t("场景卡编辑（") }}{{ local.scenes.length }}{{ t("）") }}</h3>
    <Disclosure
      v-for="s in local.scenes"
      :key="s.id"
      :title="s.location"
      :subtitle="s.id"
      :open="openScene === s.id"
      @update:open="(v) => (openScene = v ? s.id : null)"
    >
      <div class="row">
        <label class="field"><span>{{ t("地点") }}</span><input type="text" v-model="s.location" /></label>
        <label class="field"><span>{{ t("氛围") }}</span><input type="text" v-model="s.atmosphere" /></label>
        <label class="field"><span>{{ t("时间") }}</span><input type="text" v-model="s.time" /></label>
      </div>
      <label class="field">
        <span>{{ t("背景图提示词") }}</span>
        <textarea v-model="s.imagePrompt" rows="2" />
      </label>
    </Disclosure>
  </div>
</template>
