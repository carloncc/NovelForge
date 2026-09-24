/**
 * #799 世界观卡片体系（提取→上下文→只读展示，全链路最小闭环）
 * 覆盖白名单内纯函数 + 文件锚点（类型锚点注释 / 卡片页只读段）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTool,
  dedupeLore,
  finalizeState,
  loreMapOf,
  stateSummary,
  type ExtractAgentState,
} from "../src/core/extractAgent";
import {
  buildLoreContext,
  dedupeLoreCards,
  loreContextForScript,
  loreContextLine,
  normalizeLoreCard,
} from "../src/core/cards";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function freshState(): ExtractAgentState {
  return { characters: new Map(), scenes: new Map(), items: new Map(), lore: new Map() };
}

/* ---------- 1) add_lore：新增/校验/分类回退 ---------- */
{
  const state = freshState();
  let r = applyTool(state, {
    id: "t1",
    name: "add_lore",
    args: { id: "blackwater_map", title: "黑水城防线图", kind: "map", content: "北门外三里有暗河，退兵必经独木桥。" },
  });
  assert(r.ok && state.lore!.size === 1, "add_lore 应成功建卡");
  assert(loreMapOf(state).get("blackwater_map")?.kind === "map", "kind 应保留");

  r = applyTool(state, { id: "t2", name: "add_lore", args: { id: "x", title: "", content: "有内容无标题" } });
  assert(!r.ok, "缺 title 应失败");
  r = applyTool(state, { id: "t3", name: "add_lore", args: { id: "x", title: "有名无实", content: "" } });
  assert(!r.ok, "缺 content 应失败（content 须保留原文关键信息）");

  r = applyTool(state, { id: "t4", name: "add_lore", args: { id: "weird", title: "怪类", kind: "nonsense", content: "原文。" } });
  assert(r.ok && loreMapOf(state).get("weird")?.kind === "other", "非法 kind 应回退 other 而非失败");
}

/* ---------- 2) add_lore：同 id 补缺 / 不同标题分卡（与角色/场景/物品同口径） ---------- */
{
  const state = freshState();
  applyTool(state, { id: "t1", name: "add_lore", args: { id: "trial", title: "铁盟入会试炼", kind: "quest", content: "短。" } });
  let r = applyTool(state, { id: "t2", name: "add_lore", args: { id: "trial", title: "铁盟入会试炼", kind: "quest", content: "更长的后段补充。" } });
  assert(r.ok && state.lore!.size === 1, "同 id 同标题应合并而非新增");
  assert(loreMapOf(state).get("trial")?.content === "短。", "重复调用不得用后值覆盖先收录内容（首段优先）");
  r = applyTool(state, { id: "t3", name: "add_lore", args: { id: "trial", title: "盐帮漕运图", kind: "map", content: "运河三闸。" } });
  assert(r.ok && state.lore!.size === 2, "同 id 不同标题应独立建卡");
}

/* ---------- 3) dedupeLore：同标题并卡取长 content ---------- */
{
  const state = freshState();
  state.lore!.set("l1", { id: "l1", title: "黑水城防线图", kind: "map", content: "短" });
  state.lore!.set("l2", { id: "l2", title: "黑水城防线图", kind: "map", content: "北门外三里有暗河，退兵必经独木桥，全文保留。" });
  state.lore!.set("l3", { id: "l3", title: "盐帮漕运图", kind: "map", content: "运河三闸。" });
  dedupeLore(state);
  assert(state.lore!.size === 2, "同标题应并为一张");
  assert(loreMapOf(state).get("l1")?.content.includes("独木桥") ?? false, "并卡应保留更长的 content");
}

/* ---------- 4) stateSummary：含 lore；老三字段 state 不炸 ---------- */
{
  const state = freshState();
  applyTool(state, { id: "t1", name: "add_lore", args: { id: "m1", title: "盐帮漕运图", kind: "map", content: "运河三闸。" } });
  const summary = stateSummary(state);
  assert(summary.includes("盐帮漕运图"), "摘要应含 lore 标题");
  const legacy = { characters: new Map(), scenes: new Map(), items: new Map() } as ExtractAgentState;
  const legacySummary = stateSummary(legacy);
  assert(typeof legacySummary === "string" && legacySummary.includes("林骁") === false, "老三字段 state 应兼容（不抛错）");
}

/* ---------- 5) finalizeState：lore 直通成品 ---------- */
{
  const state = freshState();
  applyTool(state, { id: "t1", name: "add_lore", args: { id: "m1", title: "盐帮漕运图", kind: "map", content: "运河三闸，全文。" } });
  const out = finalizeState(state, ["alloy"], "测试小说");
  assert(out.lore?.length === 1 && out.lore[0].content === "运河三闸，全文。", "lore 应直通 ExtractionResult 且不被概括");
}

/* ---------- 6) cards.ts 纯函数：规范/去重/剧本上下文 ---------- */
{
  assert(normalizeLoreCard(null) === null, "非对象应判残卡");
  assert(normalizeLoreCard({ id: "a", title: "t", content: "" }) === null, "空 content 应判残卡");
  assert(normalizeLoreCard({ id: "a", title: "t", content: "c", kind: "zzz" })?.kind === "other", "非法 kind 回退 other");

  const dupes = dedupeLoreCards([
    { id: "a", title: "盐帮漕运图", kind: "map", content: "短" },
    { id: "b", title: "盐帮漕运图", kind: "map", content: "运河三闸，全文更长。" },
    { id: "", title: "残", content: "卡" },
  ]);
  assert(dupes.length === 1 && dupes[0].content.includes("全文更长"), "去重应并卡取长并丢残卡");

  assert(buildLoreContext(undefined) === "" && buildLoreContext([]) === "", "无 lore 返回空串（调用方不注入）");
  const line = loreContextLine({ id: "m1", title: "盐帮漕运图", kind: "map", content: "运河三闸。" });
  assert(line.includes("m1") && line.includes("盐帮漕运图") && line.includes("运河三闸。"), "上下文行应含 id/标题/全文");
  const section = loreContextForScript({ lore: [{ id: "m1", title: "盐帮漕运图", kind: "map", content: "运河三闸。" }] });
  assert(section.startsWith("世界观设定卡："), "剧本节应有固定节头（供剧本 user 消息拼在场景卡之后）");
  assert(loreContextForScript({}) === "", "缺 lore 字段返回空串");
}

/* ---------- 7) 文件锚点：类型定义与卡片页只读段 ---------- */
{
  const types = read("src/core/types.ts");
  assert(types.includes("/** 世界观卡片（#799） */"), "types.ts 必须有唯一锚点注释");
  assert(types.includes("interface LoreCard"), "types.ts 必须追加 LoreCard 定义");

  const editCards = read("src/components/EditCards.vue");
  assert(editCards.includes("openLore"), "卡片页应有 lore 折叠态");
  assert(editCards.includes("local.lore"), "卡片页应展示 lore");
  assert(editCards.includes("世界观卡"), "卡片页应有世界观卡文案");
  assert(editCards.includes("disabled") && editCards.includes("readonly"), "lore 展示段必须只读（disabled+readonly，无 v-model 可写）");
  const loreAnchor = editCards.indexOf("<!-- #799");
  assert(loreAnchor > 0, "卡片页 lore 段应有 #799 模板锚点注释");
  assert(!/v-model=/.test(editCards.slice(loreAnchor)), "lore 段内不得出现可写绑定");
}

console.log("unit-nb-nh-799: 全部通过 ✅");
