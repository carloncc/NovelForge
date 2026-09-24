import { tauri } from "./tauri";
import { dirname, joinPath, normalizePath } from "./path";
import { createError, ErrorCode, safeAsync } from "./errors";
import { log } from "./logger";

const REQUIRED_FILES = ["index.html"];
const REQUIRED_DIRS = ["assets", "game", "icons"];

/** 主题 CSS 最小字节数（与 scripts/check-template.mjs 同口径：<512B 视为空模板/未回填） */
export const TEMPLATE_THEME_MIN_BYTES = 512;

/** #1382 模板回填探测结果（纯数据，便于单测） */
export interface TemplateFillProbe {
  /** game/userStyleSheet.css 是否存在 */
  themeExists: boolean;
  /** game/userStyleSheet.css 字节数（base64 长度换算，近似） */
  themeBytes: number;
  /** game/vocal 下内置音效（.wav）数量 */
  vocalWavCount: number;
}

/**
 * 纯函数（#1382）：模板回填缺失项 → 明确警告文案；空数组=完整。
 * 主题 0 字节/缺失 → 成品回退 WebGAL 默认样式（入口页/文本框/选项全变样）；
 * 内置 SE 空目录 → 开启音效时 playEffect 全部 404。两者此前在组装/开发路径静默产出。
 */
export function templateFillProblems(p: TemplateFillProbe): string[] {
  const problems: string[] = [];
  if (!p.themeExists) {
    problems.push("game/userStyleSheet.css 缺失（主题未回填）");
  } else if (p.themeBytes < TEMPLATE_THEME_MIN_BYTES) {
    problems.push(`game/userStyleSheet.css 为空模板（${p.themeBytes} 字节，主题未回填）`);
  }
  if (p.vocalWavCount === 0) {
    problems.push("game/vocal 目录没有内置音效（未回填，开启音效时 playEffect 会全部 404）");
  }
  return problems;
}

/** 探测模板回填状态（读主题大小 + 清点内置 SE）；任何读取失败按缺失处理，不阻断 */
export async function probeTemplateFill(templateDir: string): Promise<TemplateFillProbe> {
  let themeExists = false;
  let themeBytes = 0;
  try {
    const themePath = joinPath(templateDir, "game/userStyleSheet.css");
    if (await tauri.pathExists(themePath)) {
      themeExists = true;
      const b64 = await tauri.readFileBase64(themePath);
      themeBytes = Math.floor((b64.length * 3) / 4); // base64 → 近似字节数
    }
  } catch {
    /* 读不到按缺失处理 */
  }
  let vocalWavCount = 0;
  try {
    const entries = await tauri.listDir(joinPath(templateDir, "game/vocal"));
    vocalWavCount = entries.filter((e) => !e.isDir && /\.wav$/i.test(e.name)).length;
  } catch {
    /* 目录缺失/不可读按 0 处理 */
  }
  return { themeExists, themeBytes, vocalWavCount };
}

/**
 * 组装/开发路径的模板回填校验（#1382）：返回明确警告（空=完整），由调用方 log/提示。
 * 供 resolveTemplateDir（dev 启动）与 assembleProject（应用内组装）共用，避免只靠 pnpm build 兜底。
 */
export async function validateTemplateFill(templateDir: string): Promise<string[]> {
  try {
    return templateFillProblems(await probeTemplateFill(templateDir));
  } catch {
    return [];
  }
}

/**
 * 生成 WebGAL 引擎模板的候选路径，覆盖多种运行/打包布局：
 * - 标准布局：<resourceDir>/templates/webgal（便携版、NSIS 安装、dev target 目录）
 * - resourceDir 位于 <app>/resources 时，模板可能被放在 <app>/templates
 * - 某些 Windows 安装布局把模板放在 <exe>/resources/templates
 * - 浏览器（web）模式：resourceDir() 即模板根目录本身（/app/template）
 */
export function templateCandidates(resourceDir: string): string[] {
  const base = normalizePath(resourceDir).replace(/\/+$/, "");
  const parent = dirname(base);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [base, parent, joinPath(base, "resources")]) {
    const cand = joinPath(b, "templates", "webgal");
    if (!seen.has(cand)) {
      seen.add(cand);
      out.push(cand);
    }
  }
  if (!seen.has(base)) {
    seen.add(base);
    out.push(base);
  }
  return out;
}

async function isValidTemplate(dir: string): Promise<boolean> {
  const checks: Record<string, boolean> = {};
  for (const f of REQUIRED_FILES) {
    checks[f] = await tauri.pathExists(joinPath(dir, f));
  }
  for (const d of REQUIRED_DIRS) {
    checks[d] = await tauri.pathExists(joinPath(dir, d));
  }
  log.debug("template", "模板结构校验", { dir, checks });
  return Object.values(checks).every(Boolean);
}

export async function resolveTemplateDir(): Promise<string> {
  return safeAsync(async () => {
    const resourceDir = normalizePath(await tauri.resourceDir());
    log.debug("template", "开始解析模板目录", { resourceDir, raw: await tauri.resourceDir() });
    const candidates = templateCandidates(resourceDir);
    for (const cand of candidates) {
      log.debug("template", "尝试候选模板路径", { cand });
      if (await isValidTemplate(cand)) {
        // #1382：dev 启动也校验回填（主题 0 字节 / 内置 SE 空目录），否则组装会静默产出缺主题/缺音效的成品
        const fillProblems = await validateTemplateFill(cand);
        if (fillProblems.length) {
          log.warn("template", `模板已找到但回填不完整（${fillProblems.join("；")}）——成品会缺失定制主题/内置音效，请运行 pnpm prepare:template 回填`, { cand });
        }
        log.info("template", "模板解析成功", { cand });
        return cand;
      }
    }
    log.error("template", "未找到可用的 WebGAL 模板", { resourceDir, candidates });
    throw createError(ErrorCode.TEMPLATE_NOT_FOUND, {
      resourceDir,
      checkedPaths: candidates.join(" | "),
    });
  }, ErrorCode.TEMPLATE_NOT_FOUND);
}
