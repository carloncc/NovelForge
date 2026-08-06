import { tauri } from "./tauri";
import { dirname, joinPath, normalizePath } from "./path";
import { createError, ErrorCode, safeAsync } from "./errors";
import { log } from "./logger";

const REQUIRED_FILES = ["index.html"];
const REQUIRED_DIRS = ["assets", "game", "icons"];

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
