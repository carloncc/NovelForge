/**
 * #1382 模板回填校验纯函数：主题 0 字节 / 内置 SE 空目录必须给出明确警告（不静默产出）。
 * 与 scripts/check-template.mjs 的构建期门槛同口径；此处锁定组装/开发路径复用的纯函数。
 */
import { TEMPLATE_THEME_MIN_BYTES, templateFillProblems, type TemplateFillProbe } from "../src/utils/template";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(TEMPLATE_THEME_MIN_BYTES === 512, "主题最小字节阈值应为 512（与 check-template.mjs 同口径）");

/* ---------- 完整模板：无问题 ---------- */
const good: TemplateFillProbe = { themeExists: true, themeBytes: 8000, vocalWavCount: 8 };
assert(templateFillProblems(good).length === 0, "完整模板不应报问题");

/* ---------- 主题 0 字节：报「空模板」 ---------- */
{
  const p = templateFillProblems({ themeExists: true, themeBytes: 0, vocalWavCount: 8 });
  assert(p.length === 1 && p[0].includes("空模板"), `0 字节主题应报空模板，实际 ${JSON.stringify(p)}`);
}

/* ---------- 主题 <512 字节：同样视为未回填 ---------- */
{
  const p = templateFillProblems({ themeExists: true, themeBytes: TEMPLATE_THEME_MIN_BYTES - 1, vocalWavCount: 8 });
  assert(p.length === 1 && p[0].includes("空模板"), "小于阈值应报空模板");
  const ok = templateFillProblems({ themeExists: true, themeBytes: TEMPLATE_THEME_MIN_BYTES, vocalWavCount: 8 });
  assert(ok.length === 0, "刚好达到阈值应视为已回填");
}

/* ---------- 主题缺失 ---------- */
{
  const p = templateFillProblems({ themeExists: false, themeBytes: 0, vocalWavCount: 8 });
  assert(p.length === 1 && p[0].includes("缺失"), "缺主题应报缺失");
}

/* ---------- 内置 SE 空目录 ---------- */
{
  const p = templateFillProblems({ themeExists: true, themeBytes: 8000, vocalWavCount: 0 });
  assert(p.length === 1 && p[0].includes("音效"), "空 SE 目录应报音效问题");
}

/* ---------- 两项都缺：各报一条 ---------- */
{
  const p = templateFillProblems({ themeExists: true, themeBytes: 0, vocalWavCount: 0 });
  assert(p.length === 2, "主题与音效都缺应各报一条");
}

console.log("=== #1382 template fill validation tests passed ===");
