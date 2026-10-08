/**
 * #1515：cgEvent 缺 imagePrompt 不得让整章报废。
 *
 * 实测来源：用户项目 30 章剧本缓存里有 5 章（2/4/14/16/24）共 11 处 cgEvent 形如
 * `{"triggerIndex":6}` —— 模型漏了 imagePrompt。旧实现下 parseChapterScript 直接抛错，
 * 而它**所有调用点都是读缓存**：
 *   · pipeline.readCachedScript 抛错 → 记 "剧本缓存结构非法，已按缺失处理（将重生成）"
 *     → 整章按 cache-miss 重新调用付费 API；
 *   · useChapterStatus 捕获后 script=null → 界面显示"剧本未生成"，用户照提示再点一次生成；
 *   · project.loadScriptForChapter / imageStory 载入同样报废。
 * 即一处可选字段缺失 → 整章重付费，而这一章其余内容完好。
 *
 * 本测试锁住读侧（放行并补空串）与写侧（buildCgEvent 归一化）两侧，
 * 并守住反面：这次放宽只针对 imagePrompt，其余校验必须照旧严格。
 */
import { parseChapterScript } from "../src/core/dataValidation";
import { buildCgEvent } from "../src/core/script";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 最小合法章节：必填字段口径取自 dataValidation 的校验项 */
function fixture(scene: Record<string, unknown> = {}): unknown {
  return {
    chapter: 1,
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: "loc",
        atmosphere: "atm",
        time: "day",
        bgPrompt: "bg",
        itemEvents: [],
        lines: [{ type: "narration", text: "台词" }],
        figures: [],
        ...scene,
      },
    ],
  };
}

// ① 读侧：用户真实数据里的形态（cgEvent 只有 triggerIndex）
const parsed = parseChapterScript(fixture({ cgEvent: { triggerIndex: 6 } }));
const cg = parsed.scenes[0].cgEvent;
assert(cg, "缺 imagePrompt 的 cgEvent 不得让整章报废");
assert(cg.imagePrompt === "", `imagePrompt 应被补成空串，实际 ${JSON.stringify(cg.imagePrompt)}`);
assert(cg.triggerIndex === 6, "triggerIndex 必须原样保留");

// ② 写侧：模型什么都没给时也必须产出 schema 合法的 CgEvent
const built = buildCgEvent({}, 3);
assert(built.imagePrompt === "", "buildCgEvent 必须把缺失的 imagePrompt 归一化成字符串");
assert(typeof built.title === "string" && typeof built.description === "string", "title/description 同样必须是字符串");
assert(built.triggerIndex === 3, "triggerIndex 必须按传入值");

// ③ 模型给了值时必须原样保留，不得被归一化冲掉
const built2 = buildCgEvent({ title: "CG1", description: "d", imagePrompt: "1girl, solo" }, 0);
assert(built2.imagePrompt === "1girl, solo", "模型给了 imagePrompt 时必须原样保留");
assert(built2.title === "CG1" && built2.description === "d", "模型给了 title/description 时必须原样保留");

// ④ 不变量：写侧产物一定能被读侧接受（"写出去的缓存一定能读回来"）
const roundTrip = parseChapterScript(fixture({ cgEvent: buildCgEvent({}, 0) }));
assert(roundTrip.scenes[0].cgEvent?.imagePrompt === "", "写侧产物必须能通过读侧校验");

// ⑤ 反面：这次放宽只针对 imagePrompt，其余校验必须照旧严格
const strict: [string, unknown][] = [
  ["cgEvent 不是对象", fixture({ cgEvent: "nope" })],
  ["台词 text 为空白", fixture({ lines: [{ type: "narration", text: "  " }] })],
  ["场景缺 bgPrompt", fixture({ bgPrompt: undefined })],
  ["itemEvent 的 itemId 为空", fixture({ itemEvents: [{ itemId: "", action: "show", triggerIndex: 0 }] })],
  ["章节号非法", { chapter: -1, title: "x", scenes: [] }],
];
for (const [label, input] of strict) {
  let threw = false;
  try {
    parseChapterScript(input);
  } catch {
    threw = true;
  }
  assert(threw, `${label} 必须仍然被拒绝`);
}

console.log("=== cgEvent 缺 imagePrompt 容错测试通过（读侧放行 + 写侧归一化 + 其余校验照旧严格）===");
