import type { ApiConfig, VoiceProfile } from "./types";
import { ttsConfigById, upsertVoiceProfile } from "../stores/config";
import { tauri } from "../utils/tauri";
import { minimaxVoiceLabel } from "./minimaxVoices";

function decodeBase64Text(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function jsonResponse(response: { status: number; bodyBase64: string }): Record<string, unknown> {
  const text = decodeBase64Text(response.bodyBase64);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`MiniMax 返回了无效 JSON（HTTP ${response.status}）`); }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof (parsed as Record<string, unknown>)?.base_resp === "object"
      ? JSON.stringify((parsed as Record<string, unknown>).base_resp)
      : text.slice(0, 300);
    throw new Error(`MiniMax 克隆请求失败（HTTP ${response.status}）：${message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("MiniMax 克隆响应格式无效");
  return parsed as Record<string, unknown>;
}

function apiUrl(config: ApiConfig, path: string): string {
  const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${base}${path}`;
}

function assertMiniMaxConfig(config: ApiConfig): void {
  if (config.adapter !== "minimax-tts" && !/minimaxi?\.com/i.test(config.baseUrl)) {
    throw new Error("声音克隆目前只支持 MiniMax TTS 配置，请选择 MiniMax 配置");
  }
}

function authHeaders(config: ApiConfig): Record<string, string> {
  if (!config.apiKey.trim()) throw new Error("所选 TTS 配置没有 API Key");
  return { Authorization: `Bearer ${config.apiKey}` };
}

function extractVoiceId(payload: Record<string, unknown>): string {
  const candidates = [payload.voice_id, (payload.data as Record<string, unknown> | undefined)?.voice_id];
  const voiceId = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!voiceId) throw new Error("MiniMax 响应中没有 voice_id");
  return voiceId;
}

function extractFileId(payload: Record<string, unknown>): string {
  const candidates = [payload.file_id, (payload.data as Record<string, unknown> | undefined)?.file_id];
  const fileId = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!fileId) throw new Error("MiniMax 上传响应中没有 file_id");
  return fileId;
}

function multipartBody(fileName: string, mime: string, audioB64: string): { bodyBase64: string; contentType: string } {
  const boundary = `----NovelForgeVoice${crypto.randomUUID().replaceAll("-", "")}`;
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/["\\\r\n]/g, "_")}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const audioBytes = Uint8Array.from(atob(audioB64), (character) => character.charCodeAt(0));
  const body = new Uint8Array(prefixBytes.length + audioBytes.length + suffixBytes.length);
  body.set(prefixBytes); body.set(audioBytes, prefixBytes.length); body.set(suffixBytes, prefixBytes.length + audioBytes.length);
  return { bodyBase64: encodeBase64(body), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function importVoiceProfile(input: { name: string; configId: string; voiceId: string }): Promise<VoiceProfile> {
  const config = ttsConfigById(input.configId);
  if (!config) throw new Error("找不到所选 TTS 配置");
  assertMiniMaxConfig(config);
  const vid = input.voiceId.trim();
  if (!vid) throw new Error("voice_id 不能为空");
  // 导入即校验：乱填以前显示"已绑定"，到配音阶段才爆错难查。现在拉取可用音色当场核对。
  let remote: MiniMaxRemoteVoice[];
  try {
    remote = await fetchMiniMaxVoices(config, "all");
  } catch (e) {
    throw new Error(`音色列表查询失败，无法校验 voice_id（网络或 Key 问题）：${e instanceof Error ? e.message : String(e)}`);
  }
  const hit = remote.find((v) => v.voice_id === vid);
  if (!hit) {
    throw new Error(`voice_id「${vid}」不存在（已核对 ${remote.length} 个可用音色）：请检查是否填错，或该音色不在当前 Key 下`);
  }
  const profile: VoiceProfile = {
    id: crypto.randomUUID(), name: input.name.trim() || hit.voice_name || vid, provider: "minimax",
    ttsConfigId: config.id, voiceId: vid, status: "ready", revision: 1, createdAt: new Date().toISOString(),
  };
  upsertVoiceProfile(profile);
  return profile;
}

export async function createMiniMaxVoiceProfile(input: {
  name: string; configId: string; fileName: string; mime: string; audioB64: string; consent: boolean;
}): Promise<VoiceProfile> {
  if (!input.consent) throw new Error("创建克隆声音前必须确认你拥有参考声音的使用授权");
  const config = ttsConfigById(input.configId);
  if (!config) throw new Error("找不到所选 TTS 配置");
  assertMiniMaxConfig(config);
  if (input.audioB64.length > 16 * 1024 * 1024) throw new Error("参考音频过大，请选择不超过 12MB 的文件");
  const headers = authHeaders(config);
  const multipart = multipartBody(input.fileName, input.mime, input.audioB64);
  const upload = jsonResponse(await tauri.http({ method: "POST", url: apiUrl(config, "/v1/files/upload"), headers: { ...headers, "Content-Type": multipart.contentType }, bodyBase64: multipart.bodyBase64 }));
  const fileId = extractFileId(upload);
  const clone = jsonResponse(await tauri.http({
    method: "POST",
    url: apiUrl(config, "/v1/voice_clone"),
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: `novelforge_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      // 官方示例始终携带 model：指定与配置一致的合成模型，避免默认值导致复刻质量不符预期
      ...(config.model ? { model: config.model } : {}),
    }),
  }));
  const profile: VoiceProfile = {
    id: crypto.randomUUID(), name: input.name.trim() || "MiniMax 克隆声音", provider: "minimax", ttsConfigId: config.id,
    voiceId: extractVoiceId(clone), status: "ready", consentConfirmedAt: new Date().toISOString(), revision: 1, createdAt: new Date().toISOString(),
  };
  upsertVoiceProfile(profile);
  return profile;
}

/** 从 MiniMax 获取可用音色（系统 + 用户克隆/设计）。voice_type: system/voice_cloning/voice_generation/all */
export interface MiniMaxRemoteVoice {
  voice_id: string;
  voice_name: string;
  kind: "system" | "clone" | "design";
  gender?: string;
  language?: string;
  description?: string;
}

export async function fetchMiniMaxVoices(config: ApiConfig, voiceType: "system" | "all" = "all"): Promise<MiniMaxRemoteVoice[]> {
  assertMiniMaxConfig(config);
  const headers = authHeaders(config);
  const resp = await tauri.http({
    method: "POST",
    url: apiUrl(config, "/v1/get_voice"),
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ voice_type: voiceType }),
    timeoutSecs: 60,
  });
  const payload = jsonResponse(resp);
  if ((payload.base_resp as Record<string, unknown> | undefined)?.status_code !== 0) {
    throw new Error(`MiniMax 音色查询失败：${JSON.stringify(payload.base_resp ?? "")}`);
  }
  const out: MiniMaxRemoteVoice[] = [];
  const sections: Array<[keyof typeof payload, "system" | "clone" | "design"]> = [
    ["system_voice", "system"],
    ["voice_cloning", "clone"],
    ["voice_generation", "design"],
  ];
  for (const [key, kind] of sections) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const v of list as Array<Record<string, unknown>>) {
      if (typeof v.voice_id !== "string" || !v.voice_id) continue;
      const name = typeof v.voice_name === "string" && v.voice_name ? v.voice_name : minimaxVoiceLabel(v.voice_id);
      out.push({
        voice_id: v.voice_id,
        voice_name: name,
        kind,
        gender: typeof v.gender === "string" ? v.gender : undefined,
        language: typeof v.language === "string" ? v.language : undefined,
        description: Array.isArray(v.description) ? String(v.description[0] ?? "") : typeof v.description === "string" ? v.description : undefined,
      });
    }
  }
  return out;
}
