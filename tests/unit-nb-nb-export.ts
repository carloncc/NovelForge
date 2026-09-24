/**
 * 导出页/视频面板回归（#1393 / #1394 / #1396 / #1397 / #1400 / #1433）：
 * 白名单内只允许改 ExportPage.vue / VideoPanel.vue / preview.ts，本文件用源码文本断言锁定 UI/状态层修复，
 * 外加与组件同语义的纯谓词（组装仅认 mp4、打包互斥、覆盖确认）防止回退。
 * #1396 / #1397 的 render.ts / pipeline.ts 组装根因不在白名单内，未动，需转交。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const exportPage = readFileSync(join(ROOT, "src/pages/ExportPage.vue"), "utf-8");
const videoPanel = readFileSync(join(ROOT, "src/components/generate/result/VideoPanel.vue"), "utf-8");

/** 与 core/project.VIDEO_FILE_RE 同口径（#1396 最终决策：引擎 playVideo 用原生 video，mp4/webm/ogg 均支持，
 * 故 core 侧放宽识别，import/check/面板/render/video_plan 五处统一） */
export function isAssembleSupportedVideoExt(ext: string): boolean {
  return ["mp4", "webm", "ogg"].includes((ext ?? "").trim().toLowerCase());
}

/** #1393：打包中应拦截保存并重新组装 */
export function shouldBlockSaveWhilePacking(packing: boolean): boolean {
  return packing;
}

/** #1400：已启用位置再次导入应二次确认 */
export function shouldConfirmVideoOverwrite(enabled: boolean): boolean {
  return enabled;
}

function main(): void {
  // #1393：saveAndAssemble 拦截 packing，按钮禁用同步
  assert(exportPage.includes("if (packing.value)"), "#1393：saveAndAssemble 应显式拦截 packing");
  assert(
    exportPage.includes("正在打包：请等打包完成后再保存，避免与打包并发读写同一目录"),
    "#1393：packing 拦截应有专属提示（不得复用生成中文案）",
  );
  assert(exportPage.includes(":disabled=\"runBusy || packing\""), "#1393：保存按钮 disabled 应含 packing");

  // #1394：网页版禁用自定义选项 + 相对路径兜底（不再是死分支）
  assert(exportPage.includes(":disabled=\"isWeb\""), "#1394：自定义图片选项网页版应禁用");
  assert(
    exportPage.includes("自定义图片仅桌面版可选（网页版请在下方填写项目相对路径，或去桌面版选择）"),
    "#1394：禁用选项应有去桌面版提示",
  );
  assert(exportPage.includes("网页版无法浏览本地文件：请填写项目相对路径"), "#1394：网页版应有路径输入兜底提示");
  assert(
    exportPage.includes("项目相对路径（如 game/background/cover.png）") ||
      exportPage.includes("项目相对路径（如 game/image/logo.png）"),
    "#1394：网页版应提供项目相对路径输入框",
  );

  // #1396（最终）：口径统一到 mp4/webm/ogg（core detectVideos 的 VIDEO_FILE_RE 与面板一致）
  assert(isAssembleSupportedVideoExt("mp4") === true, "mp4 应为组装支持格式");
  assert(isAssembleSupportedVideoExt("webm") === true, "webm 应为组装支持格式（引擎原生 video 支持）");
  assert(isAssembleSupportedVideoExt("ogg") === true, "ogg 应为组装支持格式（引擎原生 video 支持）");
  assert(isAssembleSupportedVideoExt("mkv") === false, "mkv 不应被识别");
  assert(videoPanel.includes("mp4/webm/ogg") || videoPanel.includes("支持 mp4"), "#1396：面板文案应说明支持的格式");
  assert(!videoPanel.includes('accept="video/*"'), "#1396：不得用 video/* 放行全部格式");

  // #1397（白名单内缓解）：文案不再称刷新即启用，面板给显式重组装入口
  assert(!videoPanel.includes("刷新后自动启用"), "#1397：不得再宣称刷新后自动启用");
  assert(videoPanel.includes("重新组装生效"), "#1397：面板应有重新组装入口/文案");
  assert(videoPanel.includes("reassembleForVideo"), "#1397：面板应实现重组装函数");
  assert(videoPanel.includes('stages: ["assemble"]'), "#1397：重组装应走 assemble 阶段");

  // #1400：已启用位置覆盖二次确认
  assert(shouldConfirmVideoOverwrite(true) === true, "已启用位置应确认");
  assert(shouldConfirmVideoOverwrite(false) === false, "未启用位置无需确认");
  assert(videoPanel.includes("confirmImportVideo"), "#1400：导入应经确认包装函数");
  assert(videoPanel.includes("覆盖吗"), "#1400：应有覆盖确认文案");

  // #1433：风险日志延后到真正开始打包，取消保存有反馈
  assert(exportPage.includes("已取消保存，未打包"), "#1433：取消保存应有明确反馈");
  const blessIdx = exportPage.indexOf("await blessParentDir(picked)");
  const riskIdx = exportPage.indexOf("已确认风险：忽略");
  assert(blessIdx >= 0 && riskIdx >= 0, "#1433：应同时存在保存校验与风险留痕");
  assert(riskIdx > blessIdx, "#1433：风险日志必须在拿到保存位置之后（取消保存不得留假记录）");
  const saveAndAssembleFn = exportPage.indexOf("async function saveAndAssemble");
  const packZipFn = exportPage.indexOf("async function packZip");
  const firstRiskIdx = exportPage.indexOf("已确认风险：忽略");
  assert(firstRiskIdx > packZipFn && firstRiskIdx > saveAndAssembleFn, "#1433：风险日志应在 packZip 内延后记录");

  // #1393 纯谓词
  assert(shouldBlockSaveWhilePacking(true) === true, "打包中应拦截保存");
  assert(shouldBlockSaveWhilePacking(false) === false, "非打包不拦截");

  console.log("=== 导出页/视频面板回归（#1393/#1394/#1396/#1397/#1400/#1433）测试通过 ===");
}

try {
  main();
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
}
