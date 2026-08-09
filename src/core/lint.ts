import { tauri } from "../utils/tauri";

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

const CMD_RE = /^(changeBg|changeFigure|intro|bgm|playEffect|end|changeScene|unlockCg|unlockBgm|label|jumpLabel|choose|miniAvatar|playVideo|setAnimation|setTempAnimation|setTransform|setTransition|setComplexAnimation):.*;$/;
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
    if (cmd === "bgm") return "bgm";
    if (cmd === "playVideo") return "video";
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
        if (assetDir && cmd !== "unlockCg") {
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
        // 对话语音参数 -xxx.mp3;
        const vocalMatch = line.match(/ -([\w\u4e00-\u9fa5.-]+\.(mp3|ogg|opus|wav));$/);
        if (vocalMatch) {
          vocalRefs++;
          const v = vocalMatch[1].toLowerCase();
          if (!assetFiles.vocal.has(v)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `配音缺失：${v}（game/vocal/ 中不存在）`);
          }
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
