import { tauri } from "../utils/tauri";
import { TTS_SPEECH_MAX_CHARS } from "./render";

export interface LintIssue {
  level: "error" | "warning";
  scope: string;
  message: string;
  /** 结构化分类码（#1311）：创建时由 lintIssueCode 统一判定；下游只读 code，
   *  不再逐处匹配中文子串（文案一改分类即错位）。老数据缺 code 时回退旧口径。 */
  code?: "missing-asset" | "fixable";
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

/** 缺失类判定的唯一口径（纯函数，供单测）：scope 前缀 + 固定 message 标记。
 *  中文子串匹配只收敛在这一个函数里，改文案时单测会立刻指出分类漂移。 */
export function lintIssueCode(scope: string, message: string): "missing-asset" | "fixable" {
  if (
    scope.startsWith("素材") ||
    message.includes("引用缺失") ||
    message.includes("配音缺失")
  ) {
    return "missing-asset";
  }
  return "fixable";
}

export function classifyLintErrors(errors: LintIssue[]): LintErrorBreakdown {
  const missingAsset: LintIssue[] = [];
  const fixable: LintIssue[] = [];
  for (const issue of errors) {
    // 有结构化码的直接读码；外部构造的老数据（无 code）回退旧口径
    const missing = issue.code
      ? issue.code === "missing-asset"
      : issue.scope.startsWith("素材") ||
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
// 1449：引擎裸选项白名单只认 ogg/mp3/wav/opus（bundle match(/.ogg|.mp3|.wav|.opus/)，flac 0 命中）。
// render 已改用 -vocal= 显式键（不校验扩展名），lint 在此拦截 flac/m4a 配音，避免“有文件但无声”静默包。
const ENGINE_VOCAL_EXTS = new Set(["mp3", "ogg", "wav", "opus"]);

export async function lintProject(outputDir: string): Promise<LintReport> {
  const report: LintReport = {
    errors: [],
    warnings: [],
    summary: { scenes: 0, lines: 0, figures: 0, bgs: 0, vocals: 0, videos: 0, missingAssets: 0 },
  };
  const err = (scope: string, message: string) =>
    report.errors.push({ level: "error", scope, message, code: lintIssueCode(scope, message) });
  const warn = (scope: string, message: string) =>
    report.warnings.push({ level: "warning", scope, message, code: lintIssueCode(scope, message) });

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

  // #1345：跳转链第二遍校验用的收集器（第一遍只收集，第二遍统一校验目标存在性）
  const labelsByFile = new Map<string, Set<string>>();
  const changeTargets: Array<{ from: string; target: string }> = [];
  const jumpTargets: Array<{ from: string; target: string }> = [];
  const chooseTargets: Array<{ from: string; target: string }> = [];
  const fileHasEnd = new Set<string>();
  const fileHasChangeScene = new Set<string>();

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
        if (END_RE.test(line)) fileHasEnd.add(f.name);
        if (line.startsWith("label:")) {
          const name = line.slice(6, -1).trim();
          // 1462：sanitizeId 折叠后撞名会跳进另一个场景的分支（render 已加哈希前缀），重复 label 从 warn 提升为 error 拦截。
          if (labels.has(name)) err(`语法(${f.name})`, `label 重复：${name}`);
          labels.add(name);
          continue;
        }
        const cmd = line.split(":")[0];
        // #1345：跳转目标收集（第二遍校验存在性；此前收集了 labels 却从未使用）
        if (cmd === "changeScene") {
          fileHasChangeScene.add(f.name);
          const target = line.slice(cmd.length + 1).split(" ")[0].replace(/;$/, "").trim();
          if (target) changeTargets.push({ from: f.name, target });
        } else if (cmd === "jumpLabel") {
          const target = line.slice(cmd.length + 1).replace(/;$/, "").trim();
          if (target) jumpTargets.push({ from: f.name, target });
        } else if (cmd === "choose") {
          const body = line.slice(cmd.length + 1).replace(/;$/, "");
          for (const part of body.split("|")) {
            const target = part.slice(part.lastIndexOf(":") + 1).trim();
            if (target) chooseTargets.push({ from: f.name, target });
          }
        }
        if (cmd === "changeBg") bgRefs++;
        if (cmd === "changeFigure") figureRefs++;
        if (cmd === "playVideo") videoRefs++;
        const assetDir = assetDirOf(cmd);
        // unlockCg/unlockBgm/playEffect 均需校验存在性；bgm:none / changeFigure:none 豁免
        // 1460 兼容：unlock 内容现为 game/background|bgm/<file> 相对路径，取 basename 比对（旧裸文件名同样兼容）。
        if (assetDir) {
          const rawName = line.slice(cmd.length + 1).split(" ")[0].replace(/;$/, "");
          const fileName = (rawName.split(/[\\/]/).pop() || rawName).toLowerCase();
          if (fileName !== "none" && !assetFiles[assetDir].has(fileName)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `引用缺失：${fileName}（game/${assetDir}/ 中不存在）`);
          }
          continue;
        }
        continue;
      }

      if (LINE_RE.test(line)) {
        lineCount++;
        // 对话语音参数 -vocal=xxx / 裸 -xxx（1449：render 已统一输出 -vocal=，旧包裸参数仍兼容校验）
        const vocalMatch = line.match(/ -(?:vocal=)?([\w\u4e00-\u9fa5.-]+\.(mp3|ogg|opus|wav|flac|m4a));$/);
        if (vocalMatch) {
          vocalRefs++;
          const v = vocalMatch[1].toLowerCase();
          const ext = (vocalMatch[2] || "").toLowerCase();
          if (!ENGINE_VOCAL_EXTS.has(ext)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `配音格式引擎不支持：${v}（WebGAL 只认 ogg/mp3/wav/opus，请转码）`);
          } else if (!assetFiles.vocal.has(v)) {
            report.summary.missingAssets++;
            err(`素材(${f.name})`, `配音缺失：${v}（game/vocal/ 中不存在）`);
          }
        }
        // 超长台词告警：与 TTS 合成上限同口径（超限会按句自动拆段配音，仍建议人工拆句以优化阅读）
        const textPart = line.split(":").slice(1).join(":").replace(/ -(?:vocal=)?[^ ]+\.(mp3|ogg|opus|wav|flac|m4a);$/, "");
        if (textPart.length > TTS_SPEECH_MAX_CHARS) {
          warn(`体验(${f.name})`, `超长台词（${textPart.length}字 > ${TTS_SPEECH_MAX_CHARS}）：已按句自动拆分配音，仍建议拆句`);
        }
        continue;
      }

      err(`语法(${f.name})`, `无法解析的语句：${line.slice(0, 60)}`);
    }

    labelsByFile.set(f.name, labels);
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

  // ---- #1345 第二遍：跳转链校验（此前 changeScene/jumpLabel/choose 目标从未解析，坏包可绿灯通过） ----
  const sceneNames = new Set(sceneFiles.map((f) => f.name));
  for (const { from, target } of changeTargets) {
    if (!sceneNames.has(target)) err(`结构(${from})`, `changeScene 目标缺失：${target}（game/scene/ 中不存在，玩到该章末会断链）`);
  }
  const jumpCheck = (from: string, target: string): void => {
    const labels = labelsByFile.get(from);
    if (labels && !labels.has(target)) err(`结构(${from})`, `跳转目标缺失：${target}（本文件无该 label，悬空跳转）`);
  };
  for (const { from, target } of jumpTargets) jumpCheck(from, target);
  for (const { from, target } of chooseTargets) jumpCheck(from, target);
  // start.txt 必须指向已存在的章节文件（此前只查存在不查内容，空 start 会静默放行黑屏包）
  if (startExists) {
    const startTargets = changeTargets.filter((t) => t.from === "start.txt").map((t) => t.target);
    if (!startTargets.length) {
      err("结构(start.txt)", "start.txt 无 changeScene（引擎打开即黑屏）");
    } else if (!startTargets.some((t) => sceneNames.has(t))) {
      err("结构(start.txt)", `start.txt 指向的章节不存在：${startTargets.join("、")}`);
    }
  }
  // flowchart.json 场景节点校验（导出页承诺「流程图可达性」却从未读取）
  try {
    const { text: flowText } = await tauri.readTextFile(`${outputDir}/game/flowchart.json`);
    const flow = JSON.parse(flowText) as { flowcharts?: Array<{ nodes?: Array<{ data?: { sceneName?: string } }> }> };
    for (const chart of flow.flowcharts ?? []) {
      for (const node of chart.nodes ?? []) {
        const sn = node.data?.sceneName;
        if (sn && sn !== "start.txt" && !sceneNames.has(sn)) {
          err("结构(flowchart.json)", `流程图节点指向缺失场景：${sn}`);
        }
      }
    }
  } catch {
    /* 流程图缺失/不可解析则跳过（组装失败另有日志，不在此误报） */
  }
  // 章节链结构：末章应有 end;、非末章应有 changeScene（只告警，避免旧包误拦）
  const chFiles = sceneFiles
    .map((f) => f.name)
    .filter((n) => /^ch\d+\.txt$/.test(n))
    .sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
  if (chFiles.length) {
    const last = chFiles[chFiles.length - 1];
    if (!fileHasEnd.has(last)) warn(`结构(${last})`, "末章缺少 end;（通关后可能无法正常结束）");
    for (const n of chFiles.slice(0, -1)) {
      if (!fileHasChangeScene.has(n)) warn(`结构(${n})`, "非末章缺少 changeScene（可能断链）");
    }
  }

  // ---- #1347：config.txt 资源引用校验（此前 lint 全程不读 config，标题曲/封面/Logo 缺失照样绿灯） ----
  try {
    const { text: cfgText } = await tauri.readTextFile(`${outputDir}/game/config.txt`);
    const cfgVal = (key: string): string | null => {
      const m = new RegExp(`^${key}:(.*);\\s*$`, "m").exec(cfgText);
      return m ? m[1].trim() : null;
    };
    const titleBgm = cfgVal("Title_bgm");
    if (titleBgm && !assetFiles.bgm.has(titleBgm.toLowerCase())) {
      report.summary.missingAssets++;
      err("素材(config.txt)", `标题曲缺失：${titleBgm}（game/bgm/ 中不存在，标题界面静音）`);
    }
    for (const key of ["Title_img", "Game_Logo"] as const) {
      const v = cfgVal(key);
      if (v && !assetFiles.background.has(v.toLowerCase())) {
        report.summary.missingAssets++;
        err("素材(config.txt)", `${key} 缺失：${v}（game/background/ 中不存在）`);
      }
    }
  } catch {
    /* config 缺失由组装阶段保证，不在此误报 */
  }

  return finish(report);
}

function finish(report: LintReport): LintReport {
  return report;
}
