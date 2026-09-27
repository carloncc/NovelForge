/**
 * 场景出场角色 figures：剧本模型产出 → 解析校验 → 缓存往返 → 图像阶段消费。
 *
 * 背景：图片小说实测 4 章 / 219 分镜里 17 张 characters 为空，会退化为纯文本生图导致人物漂移。
 * 修复链的关键是让剧本真的产出「本场景出场角色」：SYSTEM_PROMPT 新增 figures 字段，
 * mapScriptScenes 只保留合法角色 id（剔除 narrator/去重/保序），demo 路径按说话人派生。
 * 本测试锁死解析口径与 prompt 字段说明，防止后续把 figures 又写成硬编码 []。
 */
import {
  buildScriptSystemPrompt,
  demoScriptAll,
  deriveDemoFigures,
  normalizeSceneFigures,
} from "../src/core/script";
import { parseChapterScript } from "../src/core/dataValidation";
import type { Choice, ExtractionResult, Line } from "../src/core/types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cards = {
  title: "t",
  characters: [
    { id: "alice", name: "爱丽丝" },
    { id: "bob", name: "鲍勃" },
    { id: "carol", name: "卡罗尔" },
  ],
  scenes: [{ id: "s1", location: "教室" }],
  items: [],
} as unknown as ExtractionResult;

/* ---------- 1) normalizeSceneFigures：过滤/剔除 narrator/去重/保序/缺失 ---------- */
{
  // 合法 + 去重 + 保序（模型给的顺序就是场合顺序，不得重排）
  assert(normalizeSceneFigures(["bob", "alice", "bob"], cards).join() === "bob,alice", "去重且保持原顺序");
  // 非法 id 与 narrator 剔除
  assert(normalizeSceneFigures(["alice", "ghost", "narrator"], cards).join() === "alice", "非法 id / narrator 应剔除");
  assert(normalizeSceneFigures(["narrator"], cards).length === 0, "只有 narrator 时为空");
  // 缺失 / 非数组 / 非字符串项 → 空（不猜测、不回退）
  assert(normalizeSceneFigures(undefined, cards).length === 0, "缺失应为空");
  assert(normalizeSceneFigures(null, cards).length === 0, "null 应为空");
  assert(normalizeSceneFigures("alice", cards).length === 0, "字符串不是数组，应为空");
  assert(normalizeSceneFigures({ 0: "alice" }, cards).length === 0, "对象应为空");
  assert(normalizeSceneFigures(["alice", 3, null, "bob"], cards).join() === "alice,bob", "非字符串项应跳过");
  // 空白 id 剔除、两端空白裁剪
  assert(normalizeSceneFigures([" alice ", "", "   "], cards).join() === "alice", "空白 id 应剔除并裁剪");
  // 空数组是合法口径，保持为空
  assert(normalizeSceneFigures([], cards).length === 0, "空数组保持为空");
  // 重复调用确定性
  const once = normalizeSceneFigures(["carol", "alice", "bob", "alice"], cards).join();
  assert(once === "carol,alice,bob", `保序去重：${once}`);
  assert(normalizeSceneFigures(["carol", "alice", "bob", "alice"], cards).join() === once, "重复调用同结果");
}

/* ---------- 2) deriveDemoFigures：demo 按说话人派生（含分支，去重保序） ---------- */
{
  const lines: Line[] = [
    { type: "dialogue", characterId: "alice", text: "你好。" },
    { type: "narration", text: "风吹过。" },
    { type: "dialogue", characterId: "bob", text: "你也好。" },
    { type: "dialogue", characterId: "alice", text: "再会。" },
  ];
  assert(deriveDemoFigures(lines).join() === "alice,bob", `按出现顺序去重：${deriveDemoFigures(lines).join()}`);
  const choices: Choice[] = [
    { id: "c1", prompt: "相信", lines: [{ type: "dialogue", characterId: "bob", text: "…" }] },
    { id: "c2", prompt: "怀疑", lines: [{ type: "dialogue", characterId: "carol", text: "…" }] },
  ];
  assert(deriveDemoFigures([lines[0]], choices).join() === "alice,bob,carol", "分支台词说话人应排在其后");
  // narrator / 无说话人 / 空输入
  assert(deriveDemoFigures([{ type: "dialogue", characterId: "narrator", text: "x" }]).length === 0, "narrator 不算角色");
  assert(deriveDemoFigures([]).length === 0, "空输入为空");
  assert(deriveDemoFigures([{ type: "narration", text: "x" }]).length === 0, "旁白不算角色");
}

/* ---------- 3) 两种模式的系统提示都要求输出 figures ---------- */
{
  const sprite = buildScriptSystemPrompt({ imageOnly: false });
  const imageOnly = buildScriptSystemPrompt({ imageOnly: true });
  for (const [name, p] of [["sprite", sprite], ["imageOnly", imageOnly]] as const) {
    assert(p.includes("figures"), `${name} 提示词应含 figures 字段`);
    assert(p.includes("本场景出场的角色 id 数组"), `${name} 应说明 figures 语义`);
    assert(p.includes("必须如实标注"), `${name} 应强调如实标注`);
    assert(p.includes("人物一致性"), `${name} 应说明对图像一致性的影响`);
  }
}

/* ---------- 4) demo 剧本端到端：figures 按说话人派生且能过缓存校验 ---------- */
{
  const chapter = {
    index: 0,
    title: "第一章",
    text: '爱丽丝说："你好。"\n\n鲍勃说："你也好。"\n\n爱丽丝说："再会。"',
    charCount: 0,
  };
  const scripts = demoScriptAll([chapter] as never, cards);
  const figures = scripts[0].scenes[0].figures;
  assert(figures.join() === "alice,bob", `demo 应按说话人派生去重保序：${figures.join()}`);
  // 随剧本缓存往返：parseChapterScript 不得吃掉/改写 figures
  const parsed = parseChapterScript(scripts[0]);
  assert(parsed.scenes[0].figures.join() === "alice,bob", "缓存读写往返后 figures 保持");
}

console.log("=== figures 场景出场角色测试通过 ===");
