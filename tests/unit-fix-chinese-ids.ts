/**
 * 中文表情 / 动作 / 服装 id 的渲染查找兜底（Lead 收口补测）。
 *
 * 背景：提取阶段会把中文 id 归一化成英文/哈希形态（`微笑` → `happy`、`拔剑` → `a_<hash>`、
 * `礼服` → `ct_<hash>`，见 emotions.ts / ids.ts），而剧本 LLM 偶尔照抄卡面里的中文名。
 * 修复前 render.ts 只查「裸 id + sanitizeId」，中文名一律落空 → 角色静默退回默认立绘
 * （台词有情绪标注却看不出表情，属于"看得见的缺陷、看不见的原因"）。
 *
 * 本测试只验证**查找链路**（键命中），不验证哈希算法本身。
 */
import { renderChapter } from "../src/core/render";
import { normalizeEmotionId } from "../src/core/emotions";
import { normalizeEntityId } from "../src/core/ids";

const EMO_CN = "微笑";
const ACT_CN = "拔剑";
const CT_CN = "礼服";

const emoId = normalizeEmotionId(EMO_CN);
const actId = normalizeEntityId(ACT_CN, "a");
const ctId = normalizeEntityId(CT_CN, "ct");

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const card = {
  id: "alice",
  name: "爱丽丝",
  gender: "female",
  emotions: [emoId],
  actions: [{ id: actId, name: ACT_CN, prompt: "she draws her sword" }],
  costumes: [{ id: ctId, name: CT_CN, prompt: "an evening dress" }],
};

const assets = {
  bg: { s1: "bg_street.png" },
  cg: {},
  item: {},
  vocal: {},
  bgm: {},
  figure: {
    alice: "figure_alice_normal.png",
    [`alice_${emoId}`]: "figure_alice_happy.png",
    [`alice_act_${actId}`]: "figure_alice_act_sword.png",
    [`alice_ct_${ctId}`]: "figure_alice_ct_dress.png",
    [`alice_ct_${ctId}_${emoId}`]: "figure_alice_ct_dress_happy.png",
  },
};

const opts = { characters: [card], items: [], assets, figureEmotions: true, figureActions: true };

function chapterWith(lines: unknown[]): never {
  return {
    chapter: 0,
    title: "测试章",
    scenes: [
      {
        id: "s1",
        location: "街道",
        time: "夜",
        atmosphere: "",
        bgPrompt: "anime street at night",
        figures: ["alice"],
        lines,
        itemEvents: [],
        videoPoints: [],
        choices: [],
        shots: [],
      },
    ],
  } as never;
}

const render = (lines: unknown[]): string =>
  renderChapter(chapterWith(lines), opts as never, 1);

/* ① 中文表情名 → 命中归一化后的表情差分 */
{
  const txt = render([{ type: "dialogue", characterId: "alice", emotion: EMO_CN, text: "你好" }]);
  assert(txt.includes("figure_alice_happy.png"), `中文表情「${EMO_CN}」应命中 ${emoId} 差分，实际：\n${txt}`);
}

/* ② 中文动作名 → 命中归一化后的动作立绘 */
{
  const txt = render([{ type: "dialogue", characterId: "alice", action: ACT_CN, text: "拔剑出鞘" }]);
  assert(txt.includes("figure_alice_act_sword.png"), `中文动作「${ACT_CN}」应命中 ${actId} 立绘，实际：\n${txt}`);
}

/* ③ 中文服装名 + 中文表情 → 命中「归一化服装 + 归一化表情」的组合键 */
{
  const txt = render([{ type: "dialogue", characterId: "alice", costume: CT_CN, emotion: EMO_CN, text: "晚上好" }]);
  assert(
    txt.includes("figure_alice_ct_dress_happy.png"),
    `中文服装「${CT_CN}」下的中文表情应命中组合差分，实际：\n${txt}`,
  );
}

/* ④ 英文 id 回归：既有路径（裸 id）不得被兜底改坏 */
{
  const txt = render([{ type: "dialogue", characterId: "alice", emotion: emoId, text: "hi" }]);
  assert(txt.includes("figure_alice_happy.png"), `英文表情 id 不得回归，实际：\n${txt}`);
}

/* ⑤ 差分确实不存在时必须退回默认立绘（不得因兜底而输出不存在的文件） */
{
  const txt = render([{ type: "dialogue", characterId: "alice", emotion: "sad", text: "难过" }]);
  assert(txt.includes("figure_alice_normal.png"), `无 sad 差分时应退回默认立绘，实际：\n${txt}`);
  assert(!txt.includes("figure_alice_sad"), "不得引用不存在的 sad 差分文件");
}

console.log("=== 中文表情/动作/服装 id 渲染查找兜底测试通过 ===");
