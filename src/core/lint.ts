import { tauri } from "../utils/tauri";
import { TTS_SPEECH_MAX_CHARS } from "./render";

export interface LintIssue {
  level: "error" | "warning";
  scope: string;
  message: string;
}

export interface LintReport {
  errors: LintIssue[];
  warnings: LintIssue[];
  summary: {
    scenes: number;
    lines: number;
    figures: number;
    bgs: number;
    vocals: number;
    videos: number;
    missingAssets: number;
  };
}

/** 导出检查错误的分类（#1107）：素材缺失多由模板/环境回填问题导致，用户无法在生成页修复；
 *  语法/结构错误属产物可修复缺陷，打包前建议先修。分类只用于提示与留痕，不改变拦截行为。 */
export interface LintErrorBreakdown {
  /** 素材引用缺失（scope 为「素材(...)」或 message 含「引用缺失/配音缺失」） */
  missingAsset: LintIssue[];
  /** 语法/结构等产物自身缺陷 */
  fixable: LintIssue[];
}

export function classifyLintErrors(errors: LintIssue[]): LintErrorBreakdown {
  const missingAsset: LintIssue[] = [];
  const fixable: LintIssue[] = [];
  for (const issue of errors) {
    const missing =
      issue.scope.startsWith("素材") ||
      issue.message.includes("引用缺失") ||
      issue.message.includes("配音缺失");
    (missing ? missingAsset : fixable).push(issue);
  }
  return { missingAsset, fixable };
}

/** 「仍然导出」二次确认文案（纯函数，便于单测）：必须带上数量与风险说明 */
export function buildExportOverridePrompt(report: LintReport): string {
  const { missingAsset, fixable } = classifyLintErrors(report.errors);
  return [
    `导出检查发现 ${report.errors.length} 个错误：`,
    `· 素材引用缺失 ${missingAsset.length} 个（常由模板/环境回填问题导致，可能无法在本机修复）`,
    `· 语法/结构等 ${fixable.length} 个（建议先修复，否则游戏可能黑屏或卡住）`,
    "",
    "仍然打包吗？生成的 zip 可能缺少素材或存在无法运行的场景。",
  ].join("\n");
}

// 白名单 = render.ts 实际会输出的指令集合（含 filmMode/setFilter），避免把指令误判成台词。
const CMD_RE = /^(changeBg|changeFigure|intro|bgm|playEffect|end|changeScene|unlockCg|unlockBgm|label|jumpLabel|choose|playVideo|filmMode|setFilter|setAnimation|setTempAnimation|setTransform):.*;$/;
const END_RE = /^end;$/;
const LINE_RE = /^(?:[^:;\\]|\\[:;,\.`\\])*:(.*);$/;

export async function lintProject(outputDir: string): Promise<LintReport> {
  const report: LintReport = {
    errors: [],
    warnings: [],
    summary: { scenes: 0, lines: 0, figures: 0, bgs: 0, vocals: 0, videos: 0, missingAssets: 0 },
  };
  const err = (scope: string, message: string) => report.errors.push({ level: "error", scope, message });
  const warn = (scope: string, message: string) => report.warnings.push({ level: "warning", scope, message });

  const sceneDir = `${outputDir}/game/scene`;
  const startExists = await tauri.pathExists(`${sceneDir}/start.txt`);
  if (!startExists) err("结构", "缺少 start.txt（引擎无法启动）");

  let sceneFiles: { name: string; path: string }[] = [];
  try {
    sceneFiles = (await tauri.listDir(sceneDir)).filter((e) => !e.isDir && e.name.endsWith(".txt"));
  } catch {
    err("结构", "scene 目录不存在");
    return finish(report);
  }
  if (!sceneFiles.length) err("结构", "无任何章节文件");

  // 收集已存在的素材文件
  const assetFiles: Record<string, Set<string>> = {
    background: new Set(),
    figure: new Set(),
    vocal: new Set(),
    bgm: new Set(),
    video: new Set(),
  };
  for (const [dir, key] of [
    ["background", "background"],
    ["figure", "figure"],
    ["vocal", "vocal"],
    ["bgm", "bgm"],
    ["video", "video"],
  ] as const) {
    try {
      const entries = await tauri.listDir(`${outputDir}/game/${dir}`);
      for (const e of entries) {
        if (!e.isDir) assetFiles[key].add(e.name.toLowerCase());
      }
    } catch {
      /* 目录不存在视为空 */
    }
  }

  const assetDirOf = (cmd: string): string | null => {
    if (cmd === "changeBg" || cmd === "unlockCg") return "background";
    if (cmd === "changeFigure") return "figure";
    if (cmd === "bgm" || cmd === "unlockBgm") return "bgm";
    if (cmd === "playVideo") return "video";
    if (cmd === "playEffect") return "vocal";
    return null;
  };

  for (const f of sceneFiles) {
    let { text } = await tauri.readTextFile(f.path);
    text = text.replace(/^\uFEFF/, "");
    let lineCount = 0;
    let sceneCount = 0;
    let figureRefs = 0;
    let bgRefs = 0;
    let vocalRefs = 0;
    let videoRefs = 0;
    const labels = new Set<string>();

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("; ---- 场景")) {
        sceneCount++;
        continue;
      }
      if (line.startsWith(";")) continue;

      if (END_RE.test(line) || CMD_RE.test(line)) {
        if (line.startsWith("label:")) {
          const name = line.slice(6, -1).trim();
          if (labels.has(name)) warn(`语法(${f.name})`, `label 重复：${name}`);
          labels.add(name);
          continue;
        }
        const cmd = line.split(":")[0];
        if (cmd === "changeBg") bgRefs++;
        if (cmd === "changeFigure") figureRefs++;
        if (cmd === "playVideo") videoRefs++;
        const assetDir = assetDirOf(cmd);
        // unlockCg/unlockBgm/playEffect 均需校验存在性；bgm:none / changeFigure:none 豁免
        if (assetDir) {
          const fileName = line.slice(cmd.length + 1).split(" ")[0].replace(/;$/, "").toLowerCase();
          if (fileName !== "none" && !assetFiles[assetDir].has(fileName)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `引用缺失：${fileName}（game/${assetDir}/ 中不存在）`);
          }
        }
        continue;
      }

      if (LINE_RE.test(line)) {
        lineCount++;
        // 对话语音参数 -xxx.mp3;（含 flac/m4a/opus/ogg/wav 全格式）
        const vocalMatch = line.match(/ -([\w\u4e00-\u9fa5.-]+\.(mp3|ogg|opus|wav|flac|m4a));$/);
        if (vocalMatch) {
          vocalRefs++;
          const v = vocalMatch[1].toLowerCase();
          if (!assetFiles.vocal.has(v)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `配音缺失：${v}（game/vocal/ 中不存在）`);
          }
        }
        // 超长台词告警：与 TTS 合成上限同口径（超限会按句自动拆段配音，仍建议人工拆句以优化阅读）
        const textPart = line.split(":").slice(1).join(":").replace(/ -[^ ]+\.(mp3|ogg|opus|wav|flac|m4a);$/, "");
        if (textPart.length > TTS_SPEECH_MAX_CHARS) {
          warn(`体验(${f.name})`, `超长台词（${textPart.length}字 > ${TTS_SPEECH_MAX_CHARS}）：已按句自动拆分配音，仍建议拆句`);
        }
        continue;
      }

      err(`语法(${f.name})`, `无法解析的语句：${line.slice(0, 60)}`);
    }

    if (lineCount === 0 && f.name !== "start.txt") warn(`结构(${f.name})`, "章节没有任何台词");
    if (/^ch\d+\.txt$/.test(f.name) && !/^ch1\.txt$/.test(f.name) && !text.includes("label:")) {
      warn(`结构(${f.name})`, "章节缺少 label（流程图不可达）");
    }
    report.summary.scenes += sceneCount || 0;
    report.summary.lines += lineCount;
    report.summary.figures += figureRefs;
    report.summary.bgs += bgRefs;
    report.summary.vocals += vocalRefs;
    report.summary.videos += videoRefs;
  }

  return finish(report);
}

function finish(report: LintReport): LintReport {
  return report;
}
