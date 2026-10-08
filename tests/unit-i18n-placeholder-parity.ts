/**
 * #1529：i18n 占位符两端一致性。
 *
 * `t()` 的插值是字面量替换：`out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v))`。
 * 于是两端任何一处不齐，都会让**原文里的 {xxx} 直接显示在界面上**，而不是少显示一点：
 *
 * ① 字典 ↔ 字典：某语言的译文漏了 {id} 或把 {id} 写成 {name} —— 切语言后界面上出现花括号字面量。
 * ② 调用点 ↔ 字典：key 用了 {n} 但调用点没传 n —— 中文也一样照样露花括号。
 *
 * 本文件同时覆盖两条，并把解析器本身用 7 个自测用例锁住——
 * 解析器一旦退化，这条门禁会静默变成 no-op，那比没有门禁更糟。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");

/** 取 `t(key, {...})` 第二个参数的**顶层**键名：支持 { a } 简写，排除嵌套对象里的同名键 */
function topLevelKeys(src: string, start: number): Set<string> {
  let depth = 0, i = start, body = "";
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; body += c; i++;
      while (i < src.length) {
        body += src[i];
        if (src[i] === "\\") { body += src[++i] ?? ""; i++; continue; }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if ("{[(".includes(c)) { depth++; if (depth > 1) body += c; continue; }
    if ("}])".includes(c)) { depth--; if (depth === 0) break; body += c; continue; }
    if (depth === 1) body += c;
  }
  const keys = new Set<string>();
  let d = 0, k = 0;
  while (k < body.length) {
    const c = body[k];
    if ("{[(".includes(c)) { d++; k++; continue; }
    if ("}])".includes(c)) { d--; k++; continue; }
    if (d > 0) { k++; continue; }
    if (!/[A-Za-z0-9_$]/.test(c)) { k++; continue; }
    const m = /^[A-Za-z0-9_$]+/.exec(body.slice(k));
    if (!m) { k++; continue; }
    keys.add(m[0]);
    let j = k + m[0].length;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== ":") { k = j; continue; } // 简写：条目到此为止，逗号留给下一轮
    j++; // 有冒号：跳过整个值，否则值会被当成下一个键
    let d2 = 0;
    while (j < body.length) {
      const ch = body[j];
      if ("{[(".includes(ch)) d2++;
      else if ("}])".includes(ch)) { if (d2 === 0) break; d2--; }
      else if (ch === "," && d2 === 0) break;
      j++;
    }
    k = j + 1;
  }
  return keys;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const ph = (s: string): string[] => [...new Set([...String(s).matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();

function selftest(): void {
  const cases: [string, string[]][] = [
    [`, { n }));`, ["n"]],
    [`, { name, limit: 3 }));`, ["name", "limit"]],
    [`, { name, nested: { a: 1 }, n }));`, ["name", "nested", "n"]],
    [`,\n  { extra: extra.length,\n  extraNames,\n}));`, ["extra", "extraNames"]],
    [`, { a: t("x{limit}"), limit }));`, ["a", "limit"]],
    [`, { count, size: (n / 1048576).toFixed(1), downloaded }));`, ["count", "size", "downloaded"]],
    [`, { name: preset?.name ?? id, n }));`, ["name", "n"]],
  ];
  const bad: string[] = [];
  for (const [src, want] of cases) {
    const got = [...topLevelKeys(src, src.indexOf("{"))].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort()))
      bad.push(`解析器自测失败：${JSON.stringify(src.slice(0, 46))} → ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }
  assert(bad.length === 0, bad.join("\n - "));
}

function parseDict(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) map.set(JSON.parse(`"${m[1]}"`), JSON.parse(`"${m[2]}"`));
  return map;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
}

function main(): void {
  selftest();
  const LANGS = ["zh-TW", "en", "ja", "ko"];
  const dicts = new Map(LANGS.map((l) => [l, parseDict(readFileSync(`${ROOT}/src/i18n/${l}.ts`, "utf8"))]));
  const base = dicts.get("en")!;

  // ① 字典 ↔ 字典
  const dictProblems: string[] = [];
  let interpKeys = 0;
  for (const [k] of base) {
    const ref = ph(k);
    if (ref.length === 0) continue;
    interpKeys++;
    for (const lang of LANGS) {
      const got = ph(dicts.get(lang)!.get(k) ?? "");
      const missing = ref.filter((x) => !got.includes(x));
      const extra = got.filter((x) => !ref.includes(x));
      if (missing.length || extra.length)
        dictProblems.push(`${lang} 的「${k.slice(0, 60)}」占位符不一致：基准 ${JSON.stringify(ref)} → 实际 ${JSON.stringify(got)}`);
    }
  }
  assert(dictProblems.length === 0, `有 ${dictProblems.length} 条译文的占位符与 key 不一致（#1529）：\n - ${dictProblems.join("\n - ")}`);

  // ② 调用点 ↔ 字典
  const files: string[] = [];
  walk(`${ROOT}/src`, files);
  const callProblems: string[] = [];
  let interpCalls = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lineOf = (idx: number): number => src.slice(0, idx).split(/\r?\n/).length;
    for (let p = 0; p < src.length; p++) {
      if (!src.startsWith("t(", p) || /[A-Za-z0-9_$.]/.test(src[p - 1] || "")) continue;
      const rest = src.slice(p + 2);
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(rest);
      if (!m) continue;
      let key: string;
      try { key = JSON.parse(`"${m[0].slice(1, -1).replace(/"/g, '\\"')}"`); } catch { continue; }
      const need = ph(key);
      if (need.length === 0) continue;
      interpCalls++;
      const after = rest.slice(m[0].length);
      const where = `${f.slice(ROOT.length + 1)}:${lineOf(p)}`;
      if (!/^\s*,\s*\{/.test(after)) {
        callProblems.push(`${where} 的 key 用了 ${JSON.stringify(need)} 却没传参对象（#1529）`);
        continue;
      }
      const keys = topLevelKeys(after, after.indexOf("{"));
      const missing = need.filter((x) => !keys.has(x));
      if (missing.length) callProblems.push(`${where} 的 key 用了 ${JSON.stringify(need)}，实参缺 ${JSON.stringify(missing)}（#1529）`);
    }
  }
  assert(callProblems.length === 0, `有 ${callProblems.length} 处 t() 调用漏传占位符（#1529）：\n - ${callProblems.join("\n - ")}`);

  console.log(`=== 占位符一致性测试通过（#1529：${interpKeys} 条带占位符的键 × 4 语、${interpCalls} 个插值调用，解析器自测 ${7} 例通过）===`);
}

main();
