import { reactive, watch } from "vue";
import type { ApiConfig, ApiPreset, ChannelKey } from "../core/types";
import { tauri } from "../utils/tauri";

interface ConfigFile {
  presets: ApiPreset[];
  activePresetId: string;
  outputDir?: string;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_VOICE_LIBRARY = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "anna",
  "bella",
  "harry",
  "jack",
  "jim",
  "lily",
  "marvin",
  "meimei",
  "roger",
  "sarah",
  "xuanxuan",
];

export function defaultApiConfig(kind: ChannelKey): ApiConfig {
  const defaults: Partial<Record<ChannelKey, { baseUrl: string; model: string }>> = {
    llm: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
    image: { baseUrl: "https://api.siliconflow.cn/v1", model: "black-forest-labs/FLUX.1-schnell" },
    tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B" },
  };
  const d = defaults[kind]!;
  return {
    id: makeId(),
    name: kind === "llm" ? "文本模型" : kind === "image" ? "图像模型" : "语音模型",
    baseUrl: d.baseUrl,
    apiKey: "",
    model: d.model,
    extra: kind === "tts" ? { voiceLibrary: [...DEFAULT_VOICE_LIBRARY] } : {},
  };
}

export function voiceLibraryFor(cfg: ApiConfig | undefined): string[] {
  const lib = cfg?.extra?.voiceLibrary;
  return Array.isArray(lib) && lib.length ? (lib as string[]) : DEFAULT_VOICE_LIBRARY;
}

export const configState = reactive<ConfigFile>({
  presets: [{
    id: makeId(),
    name: "默认配置",
    channels: {
      llm: [defaultApiConfig("llm")],
      image: [defaultApiConfig("image")],
      tts: [defaultApiConfig("tts")],
    },
    active: { llm: "", image: "", tts: "" },
  }],
  activePresetId: "",
  outputDir: "",
});
void loadPersisted();

async function loadPersisted() {
  try {
    const raw = await tauri.readConfig();
    if (!raw || raw === "{}") return;
    const parsed = JSON.parse(raw) as ConfigFile;
    if (parsed?.presets?.length) {
      configState.presets = parsed.presets;
      configState.activePresetId = parsed.activePresetId || parsed.presets[0].id;
    }
    configState.outputDir = parsed.outputDir || "";
  } catch {
    /* ignore */
  }
}

let saveTimer: number | undefined;
watch(
  () => JSON.stringify(configState),
  () => {
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void tauri
        .writeConfig(
          JSON.stringify({
            presets: configState.presets,
            activePresetId: configState.activePresetId,
            outputDir: configState.outputDir,
          }),
        )
        .catch(() => {});
    }, 500);
  },
  { deep: true },
);

export function activePreset(): ApiPreset {
  const p = configState.presets.find((p) => p.id === configState.activePresetId);
  return p || configState.presets[0];
}

export function activeConfig(kind: ChannelKey): ApiConfig | undefined {
  const preset = activePreset();
  const id = preset.active[kind];
  if (id) {
    const found = preset.channels[kind].find((c) => c.id === id);
    if (found) return found;
  }
  return preset.channels[kind][0];
}

export function addConfig(kind: ChannelKey): void {
  const preset = activePreset();
  const cfg = defaultApiConfig(kind);
  preset.channels[kind].push(cfg);
  preset.active[kind] = cfg.id;
}

export function removeConfig(kind: ChannelKey, id: string): void {
  const preset = activePreset();
  const list = preset.channels[kind];
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  list.splice(idx, 1);
  if (preset.active[kind] === id) {
    preset.active[kind] = list[0]?.id ?? "";
  }
}

export function addPreset(): void {
  const preset: ApiPreset = {
    id: makeId(),
    name: `配置组 ${configState.presets.length + 1}`,
    channels: {
      llm: [{ ...defaultApiConfig("llm") }],
      image: [{ ...defaultApiConfig("image") }],
      tts: [{ ...defaultApiConfig("tts") }],
    },
    active: { llm: "", image: "", tts: "" },
  };
  configState.presets.push(preset);
  configState.activePresetId = preset.id;
}

export function removePreset(id: string): void {
  if (configState.presets.length <= 1) return;
  const idx = configState.presets.findIndex((p) => p.id === id);
  if (idx < 0) return;
  configState.presets.splice(idx, 1);
  if (configState.activePresetId === id) {
    configState.activePresetId = configState.presets[0].id;
  }
}
