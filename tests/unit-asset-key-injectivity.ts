/**
 * #1547 配套：把「实体 id -> 资产键」这条链上五类 id 的唯一性口径一次性钉死。
 *
 * sanitizeId 把每个非 [a-zA-Z0-9_-] 字符折叠成一个下划线，所以「微笑」「大战」都会变成 __。
 * 五类 id 各有各的防线，此前只有视频位那类漏了（#1547）：
 *   实体（人物/物品/服装/动作）：normalizeEntityId 在源头就改成「前缀 + stableHash」，不含非 ASCII
 *   场景：ensureUniqueSceneIds 按 sanitize 后的形态去重（pipeline.ts）
 *   表情：素材页按 sanitize 后的 id 去重（generate.ts，注释点名「微笑/大笑」会撞）
 *   视频位：ensureUniqueVideoPointIds 按 sanitize 后的形态去重（#1547 新增）
 *   台词上的 action/costume：源头已归一，渲染端另有「先裸查再消毒查」兜底
 */
import { sanitizeId } from "../src/core/render";
import { normalizeEntityId, stableHash } from "../src/core/ids";
import { ensureUniqueVideoPointIds } from "../src/core/script";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(a: string, b: string): void {
  assert(a === b, "期望相等：" + JSON.stringify(a) + " vs " + JSON.stringify(b) + "（#1547）");
}

/** 清洗后的形态必须两两不同 */
function assertUnique(label: string, ids: string[]): void {
  const mapped = ids.map((x) => sanitizeId(x) || "_");
  assert(new Set(mapped).size === mapped.length,
    label + " 清洗后必须互不相同，实际 " + JSON.stringify(mapped) + "（#1547）");
}

const NAMES = ["张三", "李四", "林澈", "苏晚", "战斗", "追逐", "微笑", "大笑", "第一幕", "第二幕"];

function main(): void {
  // ① 防线一：实体 id 在源头就不含非 ASCII —— 对 sanitizeId 是恒等映射
  for (const name of NAMES) {
    const id = normalizeEntityId(name, "c");
    const bad = [...id].some((ch) => ch.codePointAt(0)! > 127);
    assert(!bad, "实体 id 不得残留非 ASCII：" + name + " -> " + id + "（#1547）");
    assertEqual(id, sanitizeId(id));
  }
  assertUnique("实体 id", NAMES.map((n) => normalizeEntityId(n, "c")));

  // ② 防线一的前提：stableHash 对不同输入给出不同摘要
  const hashes = NAMES.map(stableHash);
  assert(new Set(hashes).size === hashes.length,
    "stableHash 对这组中文名必须给出不同摘要，实际 " + JSON.stringify(hashes) + "（#1547）");

  // ③ 防线二：视频位去重按 sanitize 后的形态判重
  const vps = ["战斗", "追逐", "对峙"].map((id) => ({ id }));
  ensureUniqueVideoPointIds(vps, new Set<string>());
  assertUnique("视频位 id（去重后）", vps.map((v) => v.id));

  // ④ 前提本身：中文 id 直接进 sanitizeId 确实会撞——这正是 #1547 的由来
  assertEqual(sanitizeId("战斗"), sanitizeId("追逐"));

  console.log("=== 资产键单射性测试通过（#1547：五类 id 的唯一性口径全部守住）===");
}

main();