/**
 * i18n 占位符守门：
 *   ① 四个词典对同一个键必须有同一组 {占位符}（少一个 = 该语言静默丢信息）
 *   ② 每个带占位符的 t("字面量键", { ... }) 调用点，必须把该键的占位符全部传齐
 *   ③ 不允许 t("带占位符的键") 不传第二个参数——那会在界面上直接显示 {name}
 *
 * 为什么值得守：check-i18n.mjs 管的是「键有没有词典条目」，管不到调用点，
 * 也管不到「某个语言的译文漏抄了一个 {error}」。这两种错都不报错、不编译失败，
 * 只会让用户看到花括号原文或看不到错误原因。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const LANGS = ["zh-TW", "en", "ja", "ko"];

function placeholders(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return out;
}

/** 解析词典 TS 文件里成对的 "key": "value", 行 */
function parseDict(lang: string): Map<string, string> {
  const file = join(process.cwd(), "src", "i18n", lang + ".ts");
  const src = readFileSync(file, "utf8");
  const map = new Map<string, string>();
  const re = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    try { map.set(JSON.parse(m[1]), JSON.parse(m[2])); } catch { /* 拼接串跳过 */ }
  }
  return map;
}

function srcFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, acc);
    else if (/\.(ts|vue)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function main(): void {
  const dicts = new Map<string, Map<string, string>>();
  for (const l of LANGS) dicts.set(l, parseDict(l));
  const base = dicts.get("zh-TW")!;
  assert(base.size > 1000, "词典条目数异常偏少：" + base.size + "，解析器可能失效（#1550）");
  for (const l of LANGS) {
    const d = dicts.get(l)!;
    assert(d.size === base.size, l + " 条目数 " + d.size + " != zh-TW " + base.size + "（#1550）");
  }

  const dictDiffs: string[] = [];
  for (const [k, v] of base) {
    const want = placeholders(v);
    for (const l of LANGS) {
      if (l === "zh-TW") continue;
      const got = placeholders(dicts.get(l)!.get(k) ?? "");
      const miss = [...want].filter((x) => !got.has(x));
      if (miss.length) dictDiffs.push("[" + l + "] 丢 " + miss.join(",") + " << " + k.slice(0, 40));
    }
  }
  assert(dictDiffs.length === 0, dictDiffs.slice(0, 8).join("；") + "（#1550）");

  let withOpts = 0;
  const codeDiffs: string[] = [];
  for (const f of srcFiles(join(process.cwd(), "src"))) {
    const rel = f.slice(process.cwd().length + 1);
    const src = readFileSync(f, "utf8");
    const re2 = /\bt\(\s*("(?:[^"\\]|\\.)*")\s*,\s*\{([\s\S]{0,600}?)\}\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re2.exec(src))) {
      let key: string;
      try { key = JSON.parse(m[1]); } catch { continue; }
      const want = placeholders(key);
      if (want.size === 0) continue;
      withOpts++;
      const got = new Set<string>();
      for (const k of (m[2] + "}").matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*[,:}]/g)) got.add(k[1]);
      const miss = [...want].filter((x) => !got.has(x));
      if (miss.length) {
        const line = src.slice(0, m.index).split(/\r?\n/).length;
        codeDiffs.push(rel + ":" + line + " 缺 " + miss.join(","));
      }
    }
    const re3 = /\bt\(\s*("(?:[^"\\]|\\.)*")\s*\)/g;
    while ((m = re3.exec(src))) {
      let key: string;
      try { key = JSON.parse(m[1]); } catch { continue; }
      const want = placeholders(key);
      if (want.size === 0) continue;
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      codeDiffs.push(rel + ":" + line + " 未传第二参数，界面会显示 " + [...want].join(","));
    }
  }
  assert(withOpts > 100, "带占位符的调用点只找到 " + withOpts + " 处，解析器可能失效（#1550）");
  assert(codeDiffs.length === 0, codeDiffs.slice(0, 8).join("；") + "（#1550）");

  console.log("=== i18n 占位符守门通过：4 词典 x " + base.size + " 键零差异，" + withOpts + " 个调用点占位符齐全（#1550）===");
}

main();
