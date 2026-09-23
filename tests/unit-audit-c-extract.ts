/** ReqFlow batch-c 1306：跨 chunk 按 id 合并串人物 → 同 id 不同名必须分卡 */
import { applyTool, mergeCandidates, type ExtractAgentState } from "../src/core/extractAgent";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function blankState(): ExtractAgentState {
  return { characters: new Map(), scenes: new Map(), items: new Map() };
}

/* ---------- 1) 同 id 不同名 → 分卡不融合 ---------- */
{
  const st = blankState();
  const r1 = applyTool(st, { id: "1", name: "add_character", args: { id: "zhangsan", name: "张三" } });
  assert(r1.ok, "首卡应收录");
  const r2 = applyTool(st, { id: "2", name: "add_character", args: { id: "zhangsan", name: "张四" } });
  assert(r2.ok, "分卡也应 ok");
  assert(st.characters.size === 2, `同 id 不同名必须分卡，实际 ${st.characters.size}`);
  const names = [...st.characters.values()].map((c) => c.name).sort();
  assert(names.includes("张三") && names.includes("张四"), "两人都应保留");
  // 同 id 同名 → 合并，不增卡
  const r3 = applyTool(st, { id: "3", name: "add_character", args: { id: "zhangsan", name: "张三", appearance: "高" } });
  assert(r3.ok && st.characters.size === 2, "同 id 同名应合并");
}

/* ---------- 2) 同场景 id 不同地点 → 分卡 ---------- */
{
  const st = blankState();
  applyTool(st, { id: "1", name: "add_scene", args: { id: "s1", location: "城门" } });
  applyTool(st, { id: "2", name: "add_scene", args: { id: "s1", location: "铁匠铺" } });
  assert(st.scenes.size === 2, "同 id 不同地点必须分卡");
}

/* ---------- 3) 同物品 id 不同名 → 分卡 ---------- */
{
  const st = blankState();
  applyTool(st, { id: "1", name: "add_item", args: { id: "i1", name: "剑" } });
  applyTool(st, { id: "2", name: "add_item", args: { id: "i1", name: "玉佩" } });
  assert(st.items.size === 2, "同 id 不同物品必须分卡");
}

/* ---------- 4) mergeCandidates 同名仍合并 ---------- */
{
  const st = blankState();
  applyTool(st, { id: "1", name: "add_character", args: { id: "a1", name: "林澈" } });
  applyTool(st, { id: "2", name: "add_character", args: { id: "a2", name: "林澈" } });
  assert(st.characters.size === 2, "不同 id 同名先保留两卡");
  mergeCandidates(st);
  assert(st.characters.size === 1, "同名应合并为一卡");
}

console.log("=== audit-c extract tests passed ===");
