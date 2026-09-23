/** ReqFlow batch-c 1302/1317(api)+1303+1311 部分：escalation 判定、generous 单元素、parseModelList 容错、swap 计划 */
import { shouldEscalateBudget } from "../src/api/openaiCompatible";
import { parseModelList } from "../src/api/providers";
import { sceneSwapPlan } from "../src/core/project";
import { ensureUniqueSceneIds } from "../src/core/pipeline";
import type { ChapterScript } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1302：仅空内容+length 才升级（重构后口径不变） ---------- */
assert(shouldEscalateBudget("length", ""), "空+length 应升级");
assert(!shouldEscalateBudget("length", '{"a":1'), "非空截断走续写，不升级");
assert(!shouldEscalateBudget("stop", ""), "stop 不升级");

/* ---------- 1317：parseModelList 坏条过滤 ---------- */
const models = parseModelList(
  { data: [{ id: "good" }, { bad: 1 }, { id: "" }, "plain-model", null] },
  "custom",
);
assert(models.some((m) => m.id === "good"), "好条应保留");
assert(models.some((m) => m.id === "plain-model"), "字符串条应保留");
assert(!models.some((m) => m.id === ""), "空 id 应过滤");
let threw = false;
try {
  parseModelList({ nope: 1 }, "custom");
} catch {
  threw = true;
}
assert(threw, "缺 data/models 仍应抛错");

/* ---------- 1303：swap 只删多余 ---------- */
const plan = sceneSwapPlan(["start.txt", "ch1.txt", "ch2.txt", "old.txt", "note.md"], ["start.txt", "ch1.txt", "ch2.txt"]);
assert(plan.toDelete.length === 1 && plan.toDelete[0] === "old.txt", `只删多余旧 txt，实际 ${plan.toDelete}`);
assert(sceneSwapPlan([], ["start.txt"]).toDelete.length === 0, "空现有不应删");

/* ---------- 1311/1304 后处理幂等：scene-id 去重 ---------- */
const script = {
  chapter: 0,
  title: "t",
  scenes: [
    { id: "s1", location: "a", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [], figures: [] },
    { id: "s1", location: "b", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [], figures: [] },
  ],
} as unknown as ChapterScript;
ensureUniqueSceneIds(script);
assert(script.scenes[0].id === "s1" && script.scenes[1].id === "s1_2", "重复 scene-id 应去重");

console.log("=== audit-c api/project tests passed ===");
