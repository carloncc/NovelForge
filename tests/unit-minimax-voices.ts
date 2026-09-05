import { MINIMAX_SYSTEM_VOICES, minimaxVoiceById, minimaxVoiceLabel, MINIMAX_ZH_VOICE_IDS } from "../src/core/minimaxVoices";
import { getTemplate } from "../src/api/templates";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 1) 官方系统音色数据完整且 ID 唯一
  assert(MINIMAX_SYSTEM_VOICES.length >= 60, `系统音色过少：${MINIMAX_SYSTEM_VOICES.length}`);
  const ids = new Set(MINIMAX_SYSTEM_VOICES.map((v) => v.id));
  assert(ids.size === MINIMAX_SYSTEM_VOICES.length, "系统音色 ID 重复");

  // 2) 每个音色都有中文名 / 性别 / 标签
  for (const v of MINIMAX_SYSTEM_VOICES) {
    assert(typeof v.name === "string" && v.name.length > 0, `${v.id} 缺中文名`);
    assert(v.gender === "male" || v.gender === "female" || v.gender === "other", `${v.id} 性别非法`);
    assert(Array.isArray(v.tags) && v.tags.length > 0, `${v.id} 缺标签`);
  }

  // 3) 中文音色 ID 列表与数据一致
  assert(MINIMAX_ZH_VOICE_IDS.length === MINIMAX_SYSTEM_VOICES.length, "中文 ID 列表与数据不一致");
  assert(MINIMAX_ZH_VOICE_IDS.every((id) => ids.has(id)), "中文 ID 列表含未知 ID");

  // 4) 查询与中文名
  assert(minimaxVoiceById("female-tianmei")?.name === "甜美女性音色", "female-tianmei 中文名错误");
  assert(minimaxVoiceLabel("junlang_nanyou") === "俊朗男友", "junlang_nanyou 中文名错误");
  assert(minimaxVoiceLabel("不存在的音色") === "不存在的音色", "未知音色应回退原始 ID");

  // 5) 模板音色全部在官方数据中（保证 AI 提取/合成用的 ID 有效）
  const tpl = getTemplate("minimax-tts");
  assert(tpl !== undefined, "minimax-tts 模板不存在");
  for (const v of tpl!.voices ?? []) {
    assert(ids.has(v), `模板音色 ${v} 不在官方系统音色中`);
  }

  console.log("=== MiniMax 官方音色数据测试通过 ===");
}
main();
