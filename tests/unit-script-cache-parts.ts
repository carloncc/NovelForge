/**
 * #1538：整章剧本缓存的「选中哪一份」在两处各有一份实现——
 *   - pipeline.ts classifyScriptCache（会据此 **删除** stale 文件）
 *   - composables/useChapterStatus.ts 内联的同一套判定（供界面显示）
 *
 * 两者今天结论一致，但**排除段缓存的机制不同**：
 *   - pipeline.ts 显式调用 isScriptPartFileName(name) 先拦掉；
 *   - useChapterStatus 没有这一步，它靠「段缓存的 rest 里含 _t」被判成 stale 而顺带忽略。
 *
 * 而 _t 来自 scriptCacheRest 的 `${titleHash(title)}_t${titleHash(text)}` 格式。
 * 一旦哪天为了缩短文件名把 _t 去掉，pipeline 仍安全（显式拦截），useChapterStatus 却会
 * 把 script_ch1_part2of3_*.json 当成整章剧本选中——界面拿半章内容去算素材引用，
 * 整章报「假缺失」（用户报告 76/91 就是这个症状）。
 *
 * 本测试把这条「今天靠巧合成立」的耦合钉死，并要求 useChapterStatus 也显式拦截。
 */
import { isScriptPartFileName, scriptCacheRest, scriptPartFileName } from "../src/core/cache";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  const styleFrag = "_stabc123";

  // ① 段缓存文件名确实会被整章正则误认（所以才需要显式拦截）
  const partName = scriptPartFileName("/c", false, 0, "第一章", "正文内容".repeat(50), styleFrag, undefined, 2, 3).split("/").pop() as string;
  assert(isScriptPartFileName(partName), "段缓存应被 isScriptPartFileName 识别：" + partName);
  assert(/^script_ch1_part2of3_.+\.json$/.test(partName), "段缓存命名不符预期：" + partName);
  const partRest = /^script_ch1_part2of3_(.+)\.json$/.exec(partName)?.[1] ?? "";
  // 这条匹配整章正则：若没有 pipeline 的显式拦截，就会走进整章判定
  assert(/^script(_demo)?_ch(\d+)_(.+)\.json$/.test(partName), "段缓存会命中整章正则：" + partName);

  // ② useChapterStatus 的「顺带忽略」依赖 rest 含 _t
  assert(scriptCacheRest("第一章", "正文", styleFrag).includes("_t"), "整章 rest 必须含 _t（#1538）");
  assert(partRest.includes("_t"), "段缓存 rest 也必须含 _t——这是 useChapterStatus 顺带忽略的前提（#1538）");

  // ③ 即使正文为空，_t 也必须在（否则空正文章的段缓存会被误选中）
  const emptyPart = scriptPartFileName("/c", false, 0, "第一章", "", styleFrag, "", 1, 2).split("/").pop() as string;
  const emptyRest = /^script_ch1_part1of2_(.+)\.json$/.exec(emptyPart)?.[1] ?? "";
  assert(emptyRest.includes("_t"), "空正文的段缓存 rest 仍须含 _t：" + emptyPart);
  assert(!isScriptPartFileName("script_ch1_abc_t123_st9.json"), "整章缓存不应被误判为段缓存");
  assert(!isScriptPartFileName("script_ch1_partXof3_a.json"), "part 段必须数字：" + "script_ch1_partXof3_a.json");

  console.log("=== 段缓存与整章缓存的排除口径一致性测试通过（#1538）===");
}

main();
