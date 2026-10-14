/**
 * TTS 情绪白名单回归（2026-10-14 用户实测事故）。
 *
 * 事故：MiniMax speech-2.8 对 `whisper` 直接回
 *   `400 invalid params, speech 2.8 don't support whisper（code 2013）`
 * 而剧本提示词把 `calm/whisper` 列为允许值、配置页也提供「耳语」选项 —— 于是这些台词
 * **每次合成都失败**（UI 上只显示「未知错误」，用户只能翻日志才知道原因）。
 *
 * 修法：在厂商边界过滤（`src/api/universal.ts` 的 sanitizeTtsEmotion）——
 * 不支持的值不下发，语义接近的（calm/whisper）降级成 neutral，并打 warn。
 */
import { sanitizeTtsEmotion } from "../src/api/universal";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf-8");

/* ① MiniMax：不支持的值必须被替换/丢弃，绝不能原样下发 */
assert(sanitizeTtsEmotion("minimax-tts", "whisper") === "neutral", "whisper 必须降级成 neutral（厂商明确不支持）");
assert(sanitizeTtsEmotion("minimax-tts", "calm") === "neutral", "calm 必须降级成 neutral（厂商用 neutral 表示平静）");
assert(sanitizeTtsEmotion("minimax-tts", "happy") === "happy", "厂商支持的值必须原样保留");
assert(sanitizeTtsEmotion("minimax-tts", "neutral") === "neutral", "neutral 必须原样保留");
assert(sanitizeTtsEmotion("minimax-tts", undefined) === undefined, "未标注情绪时不得凭空造一个值");

/* ② 未知值（模型偶发自造值）必须被丢弃，而不是打回 400 */
assert(sanitizeTtsEmotion("minimax-tts", "sarcastic") === undefined, "白名单外的值必须丢弃");

/* ③ 没有白名单的模板保持原行为（自定义模板不能被这条规则误伤） */
assert(sanitizeTtsEmotion("openai-tts", "whisper") === "whisper", "无白名单的模板不得改写情绪值");
assert(sanitizeTtsEmotion("my-custom-tts", "whatever") === "whatever", "自定义模板必须原样透传");

/* ④ 接线断言：MiniMax 模板确实映射了 emotion（否则白名单是死代码） */
const tpl = read("src/api/templates.ts");
assert(tpl.includes('"voice_setting.emotion": "$emotion"'), "MiniMax 模板必须映射 voice_setting.emotion");
const uni = read("src/api/universal.ts");
assert(uni.includes("sanitizeTtsEmotion("), "TTS 变量构造必须走 sanitizeTtsEmotion（否则过滤不生效）");

/* ⑤ 提示词与配置页不得再宣传厂商不支持的值
 *    （只看代码行，不看注释：注释里为了说明"为什么不要写 calm/whisper"必须提到这两个词） */
const codeOf = (rel: string): string =>
  read(rel)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const script = codeOf("src/core/script.ts");
assert(
  !script.includes("happy/sad/angry/calm/whisper/surprised"),
  "剧本提示词不得再把 calm/whisper 列进可选值枚举",
);
assert(
  script.includes("happy/sad/angry/surprised/neutral"),
  "剧本提示词的枚举必须换成厂商支持的值",
);
const cfg = read("src/pages/ConfigPage.vue");
assert(!cfg.includes('value="whisper"'), "配置页不得再提供厂商不支持的 whisper 选项");
assert(!cfg.includes('value="calm"'), "配置页不得再提供 calm（应为 neutral）");

console.log("=== TTS 情绪白名单测试通过（whisper/calm 降级、未知值丢弃、自定义模板透传） ===");
