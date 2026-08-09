<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { CharacterCard, ExtractionResult, ItemCard, SceneCard } from "../core/types";
import { activeConfig, voiceLibraryFor } from "../stores/config";
import { tauri, isTauri } from "../utils/tauri";
import { vfsWriteFileBase64 } from "../utils/vfsWeb";
import { projectState } from "../stores/project";
import { saveEditedCards } from "../core/cards";
import { open } from "@tauri-apps/plugin-dialog";
import { errMsg } from "../utils/errors";
import { recognizeCharacter } from "../core/recognize";
import { configIsUsable } from "../api/providers";

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

async function recognizeChar(c: CharacterCard): Promise<void> {
  if (!c.referenceImage) {
    savedMsg.value = "请先为该角色设置参考图（从素材库选择或上传）";
    return;
  }
  const cfg = activeConfig("vision");
  if (!configIsUsable(cfg, "vision")) {
    savedMsg.value = "图片识别 API 未配置或不可用，请先在「API 配置」页配置";
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
    reader.onerror = () => reject(new Error("文件读取失败"));
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
  savedMsg.value = "已恢复为上次生成时的卡片";
}
</script>

<template>
  <div class="card">
    <div class="row" style="justify-content: space-between; margin-bottom: 12px">
      <h3 style="margin-bottom: 0">角色卡编辑（{{ local.characters.length }}）</h3>
      <div class="row" style="flex: none">
        <button class="btn small" :disabled="busy" @click="save">保存卡片</button>
        <button class="btn secondary small" @click="reset">放弃修改</button>
      </div>
    </div>
    <p v-if="savedMsg" style="color: var(--ok); font-size: 12px; margin-bottom: 8px">{{ savedMsg }}</p>
    <p style="color: var(--text-dim); font-size: 12px; margin-bottom: 10px">
      修改角色外貌/服装/音色后保存：剧本与立绘会在下次生成时自动重新生成；背景/CG 保留。
    </p>

    <div v-for="c in local.characters" :key="c.id" style="border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; overflow: hidden">
      <div
        class="row"
        style="cursor: pointer; padding: 10px 14px; justify-content: space-between"
        @click="openChar = openChar === c.id ? null : c.id"
      >
        <span>
          <span style="color: var(--accent-2); font-weight: 600">{{ c.name }}</span>
          <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ c.id }}</span>
        </span>
        <span style="color: var(--text-dim); font-size: 12px">{{ openChar === c.id ? "▲" : "▼" }}</span>
      </div>
      <div v-if="openChar === c.id" style="padding: 12px 14px; border-top: 1px solid var(--border)">
        <div class="row">
          <label class="field"><span>姓名</span><input type="text" v-model="c.name" /></label>
          <label class="field"><span>主题色</span><input type="text" v-model="c.color" placeholder="#3b5bdb" /></label>
        </div>
        <label class="field"><span>外貌</span><input type="text" v-model="c.appearance" /></label>
        <label class="field"><span>服装</span><input type="text" v-model="c.clothing" /></label>
        <label class="field"><span>性格</span><input type="text" v-model="c.personality" /></label>
        <div class="row">
          <label class="field grow-2">
            <span>音色描述</span>
            <input type="text" v-model="c.voiceDesc" />
          </label>
          <label class="field">
            <span>TTS 音色（可输入或选择）</span>
            <input type="text" list="novelforge-voices" v-model="c.voiceName" />
            <datalist id="novelforge-voices">
              <option v-for="v in voices" :key="v" :value="v" />
            </datalist>
          </label>
        </div>
        <label class="field">
          <span>立绘提示词（imagePrompt）</span>
          <textarea v-model="c.imagePrompt" rows="3" />
        </label>
        <label class="field">
          <span>三视图提示词（threeViewPrompt，可选）</span>
          <textarea v-model="c.threeViewPrompt" rows="3" placeholder="留空则由立绘提示词自动推导" />
        </label>
        <div class="row">
          <span style="font-size: 12px; color: var(--text-dim)">参考图（图生图保持一致）：</span>
          <span v-if="c.referenceImage" class="tag ok">已设置</span>
          <span v-else class="tag">未设置</span>
          <button class="btn secondary small" @click="pickReferenceImage(c)">从素材库选择…</button>
          <button v-if="c.referenceImage" class="btn danger small" @click="c.referenceImage = undefined">清除</button>
          <input v-if="!isTauri()" ref="refImgInput" type="file" accept="image/*" style="display: none" @change="onRefImgFile" />
        </div>
        <div class="row" style="margin-top: 8px">
          <button class="btn small" :disabled="charRecognizing === c.id || !c.referenceImage" @click="recognizeChar(c)">
            <span v-if="charRecognizing === c.id" class="spinner" />
            {{ charRecognizing === c.id ? "AI 识别中…" : "用参考图 AI 识别角色（生成描述/提示词）" }}
          </button>
          <span v-if="c.referenceImage" style="font-size: 11.5px; color: var(--text-faint)">AI 会按参考图生成外貌/服装/性格/立绘与三视图提示词，填入上方字段</span>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin-bottom: 12px">物品卡编辑（{{ local.items.length }}）</h3>
    <div v-for="it in local.items" :key="it.id" style="border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; overflow: hidden">
      <div
        class="row"
        style="cursor: pointer; padding: 10px 14px; justify-content: space-between"
        @click="openItem = openItem === it.id ? null : it.id"
      >
        <span>
          <span style="color: var(--accent-2); font-weight: 600">{{ it.name }}</span>
          <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ it.id }}</span>
        </span>
        <span style="color: var(--text-dim); font-size: 12px">{{ openItem === it.id ? "▲" : "▼" }}</span>
      </div>
      <div v-if="openItem === it.id" style="padding: 12px 14px; border-top: 1px solid var(--border)">
        <label class="field"><span>名称</span><input type="text" v-model="it.name" /></label>
        <label class="field"><span>外观</span><input type="text" v-model="it.appearance" /></label>
        <label class="field"><span>剧情意义</span><input type="text" v-model="it.note" /></label>
        <label class="field">
          <span>物品图提示词</span>
          <textarea v-model="it.imagePrompt" rows="2" />
        </label>
      </div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin-bottom: 12px">场景卡编辑（{{ local.scenes.length }}）</h3>
    <div v-for="s in local.scenes" :key="s.id" style="border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; overflow: hidden">
      <div
        class="row"
        style="cursor: pointer; padding: 10px 14px; justify-content: space-between"
        @click="openScene = openScene === s.id ? null : s.id"
      >
        <span>
          <span style="color: var(--accent-2); font-weight: 600">{{ s.location }}</span>
          <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ s.id }}</span>
        </span>
        <span style="color: var(--text-dim); font-size: 12px">{{ openScene === s.id ? "▲" : "▼" }}</span>
      </div>
      <div v-if="openScene === s.id" style="padding: 12px 14px; border-top: 1px solid var(--border)">
        <div class="row">
          <label class="field"><span>地点</span><input type="text" v-model="s.location" /></label>
          <label class="field"><span>氛围</span><input type="text" v-model="s.atmosphere" /></label>
          <label class="field"><span>时间</span><input type="text" v-model="s.time" /></label>
        </div>
        <label class="field">
          <span>背景图提示词</span>
          <textarea v-model="s.imagePrompt" rows="2" />
        </label>
      </div>
    </div>
  </div>
</template>
