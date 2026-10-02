import { buildPruneKeepChapters, pruneAssetRefs } from "../src/core/pipeline";
import type { ChapterScript } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function scene(id: string, cgEvent = false): ChapterScript["scenes"][number] {
  return {
    id,
    location: `地点-${id}`,
    atmosphere: "",
    time: "",
    figures: [],
    lines: [{ type: "dialogue", characterId: "a", text: "台词" }],
    choices: [],
    itemEvents: [],
    ...(cgEvent ? { cgEvent: { title: `CG-${id}`, prompt: "cg" } } : {}),
  } as unknown as ChapterScript["scenes"][number];
}

function chapter(index: number, ids: string[], cgIds: string[] = []): ChapterScript {
  return { chapter: index, title: `第${index + 1}章`, scenes: ids.map((id) => scene(id, cgIds.includes(id))) } as unknown as ChapterScript;
}

// 停用章（index=1）的 bg/cg/vocal 映射必须保留：只传启用章会误删
const enabled = [chapter(0, ["s1"])];
const disabled = [chapter(1, ["s2"], ["s2"])];
const assets = {
  bg: { s1: "bg1.png", s2: "bg2.png", stale: "old.png" },
  cg: { s2: "cg2.png" },
  vocal: { ch0_s1_0: "v1.mp3", ch1_s2_0: "v2.mp3" },
};

// 1) 旧行为复现：只传启用章 → 停用章映射被删（bug）
const onlyEnabled = { bg: { ...assets.bg }, cg: { ...assets.cg }, vocal: { ...assets.vocal } };
pruneAssetRefs(onlyEnabled, enabled);
assert(onlyEnabled.bg["s2"] === undefined, "只传启用章时停用章 bg 应被误删（复现旧 bug）");

// 2) 新行为：补回停用章剧本 → 映射保留，真正过期（stale）仍被清理
const keep = buildPruneKeepChapters(enabled, disabled);
assert(keep.length === 2, `保留集应含 2 章，实际 ${keep.length}`);
const fixed = { bg: { ...assets.bg }, cg: { ...assets.cg }, vocal: { ...assets.vocal } };
const stat = pruneAssetRefs(fixed, keep);
assert(fixed.bg["s1"] === "bg1.png", "启用章 bg 保留");
assert(fixed.bg["s2"] === "bg2.png", "停用章 bg 必须保留");
assert(fixed.cg["s2"] === "cg2.png", "停用章 cg 必须保留");
assert(fixed.vocal["ch1_s2_0"] === "v2.mp3", "停用章配音必须保留");
assert(fixed.bg["stale"] === undefined, "真正过期映射仍应清理");

// 3) 去重：停用脚本与启用章同 index 时不重复
const dup = buildPruneKeepChapters(enabled, [chapter(0, ["s9"])]);
assert(dup.length === 1, `同 index 去重后应为 1 章，实际 ${dup.length}`);

// 4) 无停用章时原样返回
assert(buildPruneKeepChapters(enabled, []).length === 1, "无停用章时保留集不变");

console.log(`=== 剪枝停用章保护测试通过（清理过期 ${stat.bg + stat.cg + stat.vocal} 项，保留停用章映射） ===`);
