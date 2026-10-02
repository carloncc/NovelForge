import { normalizeEmotionId, normalizeCharacterEmotions } from "../src/core/emotions";
import { normalizeEntityId } from "../src/core/ids";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // ---- 1) 已知情绪词映射到标准英文 id ----
  assert(normalizeEmotionId("happy") === "happy", "happy 应保持不变");
  assert(normalizeEmotionId("HAPPY") === "happy", "大写应小写化");
  assert(normalizeEmotionId("  happy ") === "happy", "首尾空白应去除");
  assert(normalizeEmotionId("微笑") === "happy", "中文「微笑」应映射到 happy");
  assert(normalizeEmotionId("悲伤") === "sad", "中文「悲伤」应映射到 sad");
  assert(normalizeEmotionId("愤怒") === "angry", "中文「愤怒」应映射到 angry");
  assert(normalizeEmotionId("惊讶") === "surprised", "中文「惊讶」应映射到 surprised");
  assert(normalizeEmotionId("shy") === "shy", "表外英文自定义情绪应原样保留");
  assert(normalizeEmotionId("") === "", "空值应返回空串");

  // ---- 2) 关键回归：等长中文表情不得碰撞 ----
  // 旧实现 sanitizeId("微笑") 与 sanitizeId("大笑") 得到的都是同一串下划线，
  // 生成任务互相覆盖、素材页恒显示缺图。#1496 用映射 + 哈希保底解决。
  const a = normalizeEmotionId("微笑");
  const b = normalizeEmotionId("大笑");
  assert(a !== b, `等长中文表情不得碰撞，实际都是 ${a}`);

  // 未知非 ASCII 词走哈希保底：稳定、可区分
  const u1 = normalizeEmotionId("怅然若失");
  const u2 = normalizeEmotionId("怅然若失");
  const u3 = normalizeEmotionId("喜出望外");
  assert(u1 === u2, "同一未知表情两次归一化必须稳定（否则每次运行都重画）");
  assert(u1 !== u3, "不同未知表情必须得到不同 id");
  assert(/^emo_/.test(u1), `未知非 ASCII 表情应带 emo_ 前缀，实际 ${u1}`);
  assert(u1 !== normalizeEntityId("怅然若失", "a"), "表情前缀不得与动作 id 空间混淆");

  // ---- 3) 表情集归一化：强制 normal、按 id 去重、上限 10 ----
  const set1 = normalizeCharacterEmotions(["happy", "sad"]);
  assert(set1[0] === "normal", "表情集必须强制包含 normal（缺了默认立绘会整张缺失）");
  assert(set1.includes("happy") && set1.includes("sad"), "原有表情必须保留");

  // 缺 normal 时补在最前，且不重复
  const set2 = normalizeCharacterEmotions(["normal", "normal", "happy"]);
  assert(set2.filter((e) => e === "normal").length === 1, "normal 不得重复");

  // 中文同义项按 id 去重（微笑/happy 归一后是同一个 id）
  const set3 = normalizeCharacterEmotions(["微笑", "happy", "开心"]);
  assert(set3.filter((e) => e === "happy").length === 1, "归一化后同 id 必须去重");

  // 上限 10
  const many = Array.from({ length: 30 }, (_, i) => `emo${i}`);
  assert(normalizeCharacterEmotions(many).length === 10, "表情集上限应为 10");

  // 非法输入不崩、不污染
  assert(normalizeCharacterEmotions(undefined).join(",") === "normal", "非数组输入应只回退 normal");
  assert(normalizeCharacterEmotions([null, 1, {}, ""]).join(",") === "normal", "非字符串项应被忽略");
  assert(normalizeCharacterEmotions(["   "]).join(",") === "normal", "空白项应被忽略");

  // ---- 4) 归一化必须幂等（否则重跑会不断重画）----
  const once = normalizeCharacterEmotions(["微笑", "怅然若失", "happy"]);
  const twice = normalizeCharacterEmotions(once);
  assert(once.join(",") === twice.join(","), `表情归一化必须幂等：${once} vs ${twice}`);

  console.log("=== 表情 id 归一化（#1496 回归）测试通过 ===");
}

main();
