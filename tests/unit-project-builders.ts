import { buildFlowchartJson, buildThemeCss } from "../src/core/project";
import { hslOf, pickAccentColorsFromPixels } from "../src/core/themeColors";
import type { ChapterScript } from "../src/core/types";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function chapter(n: number, title: string): ChapterScript {
  return { chapter: n, title, scenes: [] } as ChapterScript;
}

function main(): void {
  // 1) 流程图：覆盖 start + 全部章节，连线连续且 id 唯一，不残留模板 demo 节点
  const json = buildFlowchartJson([chapter(0, "一"), chapter(1, "二"), chapter(2, "三")], "测试书");
  const parsed = JSON.parse(json) as {
    flowcharts: Array<{ nodes: Array<{ id: string; data: { sceneName: string } }>; edges: Array<{ id: string; source: string; target: string }> }>;
  };
  assert(parsed.flowcharts.length === 1, "应有 1 个流程图");
  const nodes = parsed.flowcharts[0].nodes;
  const edges = parsed.flowcharts[0].edges;
  assert(nodes.length === 4, `节点数应为 4（start+3 章），实际 ${nodes.length}`);
  assert(nodes.some((n) => n.data.sceneName === "start.txt"), "缺少 start 节点");
  for (const n of [1, 2, 3]) assert(nodes.some((x) => x.data.sceneName === `ch${n}.txt`), `缺少 ch${n} 节点`);
  assert(edges.some((e) => e.source === "start" && e.target === "ch1"), "缺少 start→ch1 连线");
  assert(edges.some((e) => e.source === "ch1" && e.target === "ch2"), "缺少 ch1→ch2 连线");
  assert(edges.some((e) => e.source === "ch2" && e.target === "ch3"), "缺少 ch2→ch3 连线");
  assert(new Set(edges.map((e) => e.id)).size === edges.length, "连线 id 重复");
  assert(!json.includes("demo"), "不应包含模板 demo 节点");

  // 2) 每局主题 CSS：幂等（标记只出现一次）、字体栈按语言、标题引号转义、无取色不输出空 :root
  const base = "/* 主题 */\n.x { color: red; }\n/* ===== NovelForge per-game overrides ===== */\n旧块";
  const css = buildThemeCss(base, '星"陨', "ja", {
    accent: { h: 210, s: 70, l: 60 },
    accent2: { h: 320, s: 65, l: 66 },
  });
  assert(css.split("/* ===== NovelForge per-game overrides ===== */").length === 2, "主题标记应只出现一次（幂等截断）");
  assert(!css.includes("旧块"), "旧的主题块应被截断");
  assert(css.includes("--nf-accent: hsl(210, 70%, 60%)"), "缺少主题色变量");
  assert(css.includes("--nf-accent-2: hsl(320, 65%, 66%)"), "缺少副主题色变量");
  assert(css.includes("Source Han Serif JP"), "ja 应使用日文字体栈");
  assert(css.includes('content: "星\\"陨"'), "标题中的引号未转义");
  const css2 = buildThemeCss(css, "无图", "zh_CN", null);
  assert(css2.split("/* ===== NovelForge per-game overrides ===== */").length === 2, "重复构建应保持幂等");
  assert(!css2.includes(":root {\n}"), "无取色时不应输出空 :root");
  assert(css2.includes("Microsoft YaHei"), "zh_CN 字体栈缺失");

  // 3) 主题取色：纯灰 → null；有明显主色 → 返回 accent 与色距足够的 accent2
  const gray = new Uint8ClampedArray(64 * 64 * 4).fill(120);
  for (let i = 3; i < gray.length; i += 4) gray[i] = 255;
  assert(pickAccentColorsFromPixels(gray) === null, "纯灰图不应返回主色");
  const px = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < px.length; i += 4) {
    const blue = (i / 4) % 3 !== 0;
    px[i] = blue ? 30 : 200;
    px[i + 1] = blue ? 60 : 40;
    px[i + 2] = blue ? 220 : 60;
    px[i + 3] = 255;
  }
  const pair = pickAccentColorsFromPixels(px);
  assert(pair !== null, "合成图应能取到主色");
  if (pair) {
    assert(pair.accent.h > 180 && pair.accent.h < 260, `主色应偏蓝，实际 h=${pair.accent.h}`);
    const d = Math.abs(pair.accent.h - pair.accent2.h) % 360;
    assert((d > 180 ? 360 - d : d) >= 60, "副色与主色色距应 ≥60°");
  }
  assert(hslOf({ h: 10, s: 50, l: 60 }) === "hsl(10, 50%, 60%)", "hslOf 输出异常");
  console.log("=== 组装器纯函数测试通过（流程图 / 每局主题 / 取色）===");
}

main();
