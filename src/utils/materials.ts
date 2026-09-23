import type { MaterialAsset } from "../core/types";

/** 素材自动分类（纯函数，#1288/#1367）
 *  - 补「剑」（与页面提示一致）；英文大小写不敏感（先转小写再匹配）；
 *  - char 用词边界约束，避免 chart.png 误归人物。
 *  独立模块：<script setup> 内不允许 export，放在页面里会导致 vite 构建失败。 */
export function classifyMaterial(name: string): MaterialAsset["kind"] {
  const lower = (name || "").toLowerCase();
  if (/人|角色|figure|hero/.test(lower) || /(^|[^a-z])char([^a-z]|$)/.test(lower)) return "character";
  if (/物|item|道具|剑|sword|weapon|jade/.test(lower)) return "item";
  return "background";
}
