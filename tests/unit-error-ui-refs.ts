/**
 * #1528：抛给用户看的消息若用「X」指向某个界面控件，X 本身必须是**已本地化的界面文案**，
 * 整条消息也必须走 t()。
 *
 * 理由：界面文案进了四语字典，而错误文案没进的话，英文/日文/韩文界面的用户会被告知去点一个
 * 在自己语言里根本不存在的按钮（例如中文的「重新生成描述」在 en 界面里叫别的名字）。
 * 这不是「日志不翻译」那类可接受例外——它是**指路**，必须跟着界面走。
 *
 * 判据自洽：只有「X」的内容本身就是字典键（scripts/i18n-keys.txt）时才判定为「指向界面控件」；
 * 「${vid}」「${poll.resultItemPath}」这类动态值不是字典键，天然被排除，无需白名单。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
}

function main(): void {
  const keys = new Set(
    readFileSync(`${ROOT}/scripts/i18n-keys.txt`, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  assert(keys.size > 1000, `字典键只读到 ${keys.size} 条，解析规则失效`);

  const files: string[] = [];
  walk(`${ROOT}/src`, files);
  assert(files.length > 0, "src 目录为空，扫描规则失效");

  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      const where = `${f.slice(ROOT.length + 1)}:${i + 1}`;
      // ① 硬编码整句中文又拼 t()：同一句话会输出两遍。
      //    必须**先于**下面的 t() 早退判断，否则这一类根本走不到（#1528 本轮自己踩过）。
      if (/[\u4e00-\u9fff]{6,}[^`]*`\s*\+\s*t\(/.test(line)) {
        offenders.push(`${where} 硬编码中文后又拼 t()，同句会输出两遍（#1528）`);
        return;
      }
      // ② 面向用户的报错文案：用「X」指向某个界面控件时，整条必须走 t()。
      //    范围严格限定在「抛错」与「用户可见的失败原因字段」两类，
      //    因为日志正文是运行时拼接的中文，按项目约定不本地化（LogPanel.vue 有说明）。
      const isThrow = /throw new Error\(|Promise\.reject\(new Error\(/.test(line);
      const isUserReason = /\breason:\s*["'`]/.test(line);
      if (!isThrow && !isUserReason) return;
      if (/\bt\(/.test(line)) return;
      for (const m of line.matchAll(/「([^」]+)」/g)) {
        const label = m[1];
        if (!keys.has(label)) continue;
        offenders.push(`${where} 指向界面文案「${label}」但未走 t()（#1528）`);
      }
    });
  }
  assert(offenders.length === 0, `有 ${offenders.length} 处错误用中文界面文案指路却没走 t()：\n - ${offenders.join("\n - ")}`);

  console.log(`=== 错误指路文案本地化测试通过（#1528，扫描 ${files.length} 个源文件）===`);
}

main();
