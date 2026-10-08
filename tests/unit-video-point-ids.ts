/**
 * #1547：视频推荐位 id 必须按 sanitize 后的形态唯一。
 *
 * 场景侧早就补过这个坑——ensureUniqueSceneIds 的注释写明「缓存键全都是 sanitizeId(scene.id)，
 * 而 sanitizeId 把非 [a-zA-Z0-9_-] 全替换成下划线，于是「城门」与「城楼」都会变成同一条」。
 * 视频位侧一直没补：script.ts 清洗时写的是「id: vp.id || vp_<scene>_<k>」，LLM 给了 id 就原样采用，
 * 既不归一也不去重；而 render.ts:742/846、project.ts:1193、generate.ts:3908 全都拿
 * sanitizeId(vp.id) 当视频文件名与映射键。中文 id 一清洗就同名 → 写同一个 video_*.mp4。
 */
import { ensureUniqueVideoPointIds } from "../src/core/script";
import { sanitizeId } from "../src/core/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(ids: string[], shared?: Set<string>): string[] {
  const vps = ids.map((id) => ({ id }));
  ensureUniqueVideoPointIds(vps, shared ?? new Set<string>());
  return vps.map((v) => v.id);
}

/** 跨场景/跨分块共用的同一个 used 集合 */
function runAll(groups: string[][]): string[] {
  const used = new Set<string>();
  return groups.flatMap((g) => run(g, used));
}

function main(): void {
  // ① 两个不同中文 id 清洗后同名，必须拆开
  const a = run(["战斗", "追逐"]);
  assert(new Set(a.map(sanitizeId)).size === a.length,
    "「战斗」与「追逐」清洗后同名，必须去重，实际 " + JSON.stringify(a) + "（#1547）");
  assert(a[0] === "战斗", "首次出现的 id 必须原样保留，实际 " + a[0] + "（#1547）");

  // ② sanitize 后唯一时不得改动（LLM 给的 op1 / ch2_battle 必须原样通过）
  for (const ids of [["op1"], ["ch2_battle", "ch2_rain"], ["a", "b", "c"]]) {
    assert(JSON.stringify(run(ids)) === JSON.stringify(ids),
      "本就唯一时不得改动：" + JSON.stringify(ids) + " -> " + JSON.stringify(run(ids)) + "（#1547）");
  }

  // ③ used 集合跨场景共享时，同名 id 必须继续拆开
  const cross = runAll([["战斗"], ["追逐"], ["对峙"]]);
  assert(new Set(cross.map(sanitizeId)).size === cross.length,
    "跨场景必须仍然唯一，实际 " + JSON.stringify(cross) + "（#1547）");

  // ④ 空 id 归一为 vp，不得产出空键
  const e = run(["", ""]);
  assert(e[0] === "vp", "空 id 必须归一为 vp，实际 " + JSON.stringify(e) + "（#1547）");
  assert(e.every((id) => id.length > 0), "不得产出空键，实际 " + JSON.stringify(e) + "（#1547）");

  // ⑤ 多场景多冲突后仍须唯一
  const many = runAll([["第一幕", "第二幕"], ["第一幕", "第三幕"], ["第一幕"]]);
  assert(new Set(many.map(sanitizeId)).size === many.length,
    "多场景多冲突后仍须唯一，实际 " + JSON.stringify(many.map(sanitizeId)) + "（#1547）");

  console.log("=== 视频位 id 唯一化测试通过（#1547：按 sanitize 后形态去重，跨场景共享）===");
}

main();
