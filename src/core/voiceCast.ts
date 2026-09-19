/**
 * AI 音色分配（配音导演）：按角色设定从音色库里挑音色。
 * - 提取角色卡时管线已会让 AI 选一次；本模块提供「随时重选」的独立入口（角色卡编辑页按钮）。
 * - 纯函数 applyVoiceAssignments 负责校验：id 存在、音色在库内、性别一致、主要角色尽量不撞色。
 */
import { chatJson } from "../api/openaiCompatible";
import { voiceLibraryFor } from "../stores/config";
import { minimaxVoiceLabel, pickVoiceForGender, voiceGenderOf } from "./minimaxVoices";
import type { ApiConfig, CharacterCard } from "./types";

export interface VoiceCastAssignment {
  characterId: string;
  voiceName: string;
  reason?: string;
}

/** 校验并落地 AI 的分配结果（导出以便单测；不调用网络） */
export function applyVoiceAssignments(
  characters: CharacterCard[],
  assignments: VoiceCastAssignment[],
  lib: string[],
): VoiceCastAssignment[] {
  const byId = new Map(characters.map((c) => [c.id, c]));
  const used = new Set<string>();
  const out: VoiceCastAssignment[] = [];
  for (const a of assignments ?? []) {
    const ch = a ? byId.get(a.characterId) : undefined;
    if (!ch) continue;
    let voice = lib.includes(a.voiceName) ? a.voiceName : undefined;
    // 性别校验：不允许把男声给女角色（反之亦然）
    if (voice && ch.gender) {
      const vg = voiceGenderOf(voice);
      if (vg && vg !== "other" && vg !== ch.gender) voice = undefined;
    }
    // 主要角色尽量一人一色；撞色时在同性别、未占用的音色里稳定重挑
    if (voice && used.has(voice) && !ch.isNpc) {
      voice = pickVoiceForGender(lib.filter((v) => !used.has(v)), ch.gender, ch.id);
    }
    if (!voice) voice = pickVoiceForGender(lib, ch.gender, ch.id);
    if (!voice) continue;
    used.add(voice);
    out.push({ characterId: ch.id, voiceName: voice, reason: a.reason });
  }
  return out;
}

/** 让 LLM 为角色重新挑音色；返回通过校验的分配结果 */
export async function aiAssignVoices(
  cfg: ApiConfig,
  characters: CharacterCard[],
): Promise<VoiceCastAssignment[]> {
  const lib = voiceLibraryFor(cfg);
  if (!lib.length) throw new Error("音色库为空：请先在「API 配置」里为 TTS 填写音色库");
  const libText = lib
    .map((id) => {
      const g = voiceGenderOf(id);
      const genderText = g === "male" ? "男声" : g === "female" ? "女声" : "";
      const name = minimaxVoiceLabel(id);
      const extra = [name !== id ? name : "", genderText].filter(Boolean).join("，");
      return extra ? `${id}（${extra}）` : id;
    })
    .join(", ");
  const chars = characters.map((c) => ({
    id: c.id,
    name: c.name,
    gender: c.gender ?? "",
    personality: (c.personality ?? "").slice(0, 120),
    voiceDesc: (c.voiceDesc ?? "").slice(0, 80),
    appearance: (c.appearance ?? "").slice(0, 100),
    isNpc: !!c.isNpc,
  }));
  const system = `你是视觉小说配音导演。为每个角色从「可用音色列表」中挑选最合适的音色。
规则：
1) 音色性别必须与角色 gender 一致（male 选男声，female 选女声）；如果该性别没有可用音色，选列表中性别最接近的。
2) 优先匹配 voiceDesc（音色描述）与 personality（性格/年龄气质），例如“清冷”“活泼”“沉稳”“少年”。
3) 主要角色之间避免重复（尽量一人一色）；isNpc=true 的次要角色可以复用音色。
4) voiceName 必须原样取自列表，不要编造列表外的值，也不要返回括号里的中文名。
只输出 JSON：{"assignments":[{"characterId":"...","voiceName":"...","reason":"一句话理由"}]}`;
  const user = `可用音色列表：${libText}\n\n角色列表：${JSON.stringify(chars)}\n\n请为上面每一个角色分配音色。`;
  const res = await chatJson<{ assignments?: VoiceCastAssignment[] }>(cfg, system, user, { maxTokens: 4096 });
  return applyVoiceAssignments(characters, res.assignments ?? [], lib);
}
