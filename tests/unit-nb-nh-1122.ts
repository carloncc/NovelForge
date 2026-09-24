/**
 * #1122 素材缩略图控件收敛（最小折叠方案）：
 * figure 区每缩略图的「重生成/抠图」必须收进 <details class="thumb-ops">，
 * 常驻只留复选框 + 一个「操作」折叠入口；行级批量入口与复选框保持不动。
 * Vue SFC 不挂载，仅做模板静态断言（控件数回归网）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, "src/components/generate/result/AssetPanel.vue"), "utf-8");

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// figure 区切片（item/bg/cg 为行级单按钮，不在此次收敛范围；锚定模板 v-if，避开工具栏同名表达式）
const figureStart = src.indexOf('v-if="assetTab === \'figure\'"');
const itemStart = src.indexOf('v-else-if="assetTab === \'item\'"');
assert(figureStart > 0 && itemStart > figureStart, "应能定位 figure 区模板");
const figure = src.slice(figureStart, itemStart);

const FIGURE_OPS = ["regenFigureEmotion", "regenCostume", "regenAction", "reCutout('figure'"];

/* ---------- 1) 四类缩略图的操作按钮全部在折叠菜单内 ---------- */
{
  const detailsBlocks = figure.match(/<details class="thumb-ops"[\s\S]*?<\/details>/g) ?? [];
  assert(detailsBlocks.length >= 4, `三视图/表情/服装/动作四类缩略图都应有折叠菜单，实际 ${detailsBlocks.length}`);
  for (const op of FIGURE_OPS) {
    const total = figure.split(op).length - 1;
    const inside = detailsBlocks.reduce((n, b) => n + (b.split(op).length - 1), 0);
    assert(total > 0 && inside === total, `「${op}」应全部收进折叠菜单（区内 ${total} 处，菜单内 ${inside} 处）`);
  }
  // 折叠菜单点击不得冒泡触发放大
  for (const b of detailsBlocks) assert(b.includes("@click.stop"), "折叠菜单必须 @click.stop（否则点开展开即放大）");
  // 折叠入口文案走 t() 占位
  assert(figure.includes('{{ t("操作") }}'), "折叠入口应为 t(操作)（新增文案占位）");
}

/* ---------- 2) 常驻控件：复选框保留，行级批量入口不动 ---------- */
{
  const sels = figure.match(/class="asset-sel"/g) ?? [];
  assert(sels.length >= 4, `复选框必须保留（常驻），实际 ${sels.length}`);
  assert(figure.includes("confirmRegenThreeView") && figure.includes("confirmRegenAllFigure"), "角色级联动按钮（行头）不在收敛范围，应保留");
  // 行级批量入口在工具栏（figure 区之外），对全文断言
  assert(src.includes("regenSelected") && src.includes("selectAllInTab"), "行级批量入口（全选/重生成已选）必须保留");
}

/* ---------- 3) 样式锚点 ---------- */
{
  assert(src.includes(".thumb-ops"), "应有 .thumb-ops 样式（折叠菜单最小样式）");
}

console.log("unit-nb-nh-1122: 全部通过 ✅");
