/**
 * 导出安全门禁（#1107 / #1116 / #1114）：
 * - #1107：lint 错误按「素材缺失 / 可修复」分类，二次确认文案带数量与风险说明；
 * - #1116：目标 zip 在项目目录内部时必须判为内部路径（含分隔符/大小写/尾斜杠归一化）；
 * - #1114：导出说明里 BGM 关键词成组在前，SE 段落整体在后（欢快/神秘归属 BGM）。
 */
import { buildExportOverridePrompt, classifyLintErrors, type LintReport } from "../src/core/lint";
import { buildExportGuideText } from "../src/core/project";
import { isPathInsideDir } from "../src/utils/tauri";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function report(): LintReport {
  return {
    errors: [
      { level: "error", scope: "素材(ch1.txt)", message: "引用缺失：bg.png（game/background/ 中不存在）" },
      { level: "error", scope: "素材(ch1.txt)", message: "配音缺失：v.mp3（game/vocal/ 中不存在）" },
      { level: "error", scope: "语法(ch1.txt)", message: "无法解析的语句：xxx" },
    ],
    warnings: [],
    summary: { scenes: 1, lines: 2, figures: 0, bgs: 0, vocals: 0, videos: 0, missingAssets: 2 },
  };
}

function main(): void {
  // #1107：分类只看 scope/message，不改变拦截行为之外的语义
  const r = report();
  const { missingAsset, fixable } = classifyLintErrors(r.errors);
  assert(missingAsset.length === 2, `素材缺失应为 2，实际 ${missingAsset.length}`);
  assert(fixable.length === 1, `可修复应为 1，实际 ${fixable.length}`);
  const prompt = buildExportOverridePrompt(r);
  assert(prompt.includes("3 个错误"), "确认文案应带错误总数");
  assert(prompt.includes("素材引用缺失 2 个"), "确认文案应带素材缺失数");
  assert(prompt.includes("仍然打包吗"), "确认文案应有明确的二次确认问句");

  // #1116：内部路径判定（含归一化）
  assert(isPathInsideDir("D:/book/game", "D:/book/game/out_web.zip") === true, "目录内 zip 应判内部");
  assert(isPathInsideDir("D:/book/game", "D:/book/game_web.zip") === false, "兄弟路径不得判内部");
  assert(isPathInsideDir("D:/book/game", "D:\\book\\game\\sub\\a.zip") === true, "反斜杠分隔应判内部");
  assert(isPathInsideDir("D:/book/game/", "d:/BOOK/GAME/a.zip") === true, "大小写/尾斜杠应归一化后判内部");
  assert(isPathInsideDir("D:/book/game", "D:/book/game") === false, "目录自身不是内部");
  assert(isPathInsideDir("", "D:/a.zip") === false, "空目录不得判内部");

  // #1114：BGM 五条成组在前，SE 段落在后
  const text = buildExportGuideText("测试书", "D:/out");
  const idxBattle = text.indexOf("战斗氛围");
  const idxCalm = text.indexOf("宁静氛围");
  const idxSad = text.indexOf("悲伤氛围");
  const idxHappy = text.indexOf("欢快氛围");
  const idxMystery = text.indexOf("神秘氛围");
  const idxSe = text.indexOf("环境音效（SE）");
  for (const [name, i] of [["战斗", idxBattle], ["宁静", idxCalm], ["悲伤", idxSad], ["欢快", idxHappy], ["神秘", idxMystery], ["SE", idxSe]] as const) {
    assert(i >= 0, `导出说明缺少${name}段落`);
  }
  assert(idxBattle < idxCalm && idxCalm < idxSad && idxSad < idxHappy && idxHappy < idxMystery, "BGM 五条应按序成组");
  assert(idxMystery < idxSe, "SE 段落应在 BGM 列表之后（欢快/神秘不得像 SE 规则）");

  console.log("=== 导出安全门禁（#1107/#1116/#1114）测试通过 ===");
}

try {
  main();
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
}
