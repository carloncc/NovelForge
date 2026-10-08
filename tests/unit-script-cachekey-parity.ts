/**
 * 剧本缓存键一致性护栏。
 *
 * 事故：pipeline 剧本阶段曾手工重算指纹且漏掉 cardsFp，而读取侧（含组装阶段与
 * loadDisabledScriptsForPrune）走 scriptStyleFrag()。写入键与读取键不同 →
 * 缓存 100% miss：只跑 assemble 阶段直接报「未找到与当前小说匹配的剧本缓存」；
 * 停用章保护恒失效，pruneAssetRefs 照删停用章素材。
 *
 * cache.ts 的注释已写明「所有调用点必须调用本函数」。本测试把该约束变成可执行断言：
 * 任何在 src 内手工拼装 scriptFingerprint 字面量的地方，若漏传 cardsFp 即失败。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scriptFingerprint, scriptCacheFileName } from "../src/core/cache";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function collectTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectTs(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function main(): void {
  // 1. 指纹公式本身：cardsFp 必须参与，且为空时不得污染键
  const withCards = scriptFingerprint({ style: "", compressNarration: false, cardsFp: "abc123" });
  const withoutCards = scriptFingerprint({ style: "", compressNarration: false });
  assert(withCards !== withoutCards, "cardsFp 必须参与剧本缓存指纹");
  assert(withoutCards === "", "无 style/无 cardsFp 时片段应为空串");
  assert(withCards.startsWith("_cd"), `cardsFp 片段前缀应为 _cd，实际 ${withCards}`);

  // 2. 同一章节：含 cardsFp 的键必须与「剧本阶段实际使用的口径」自洽
  const ch = { index: 0, title: "黄昏的城门", text: "正文".repeat(200) };
  const frag = scriptFingerprint({ style: "细腻", compressNarration: true, cardsFp: "abc123" });
  const file = scriptCacheFileName("/cache", false, ch.index, ch.title, ch.text, frag);
  // 指纹是键的尾部：换 cardsFp 必须换文件名，否则改卡片不会让旧剧本失效
  const other = scriptCacheFileName("/cache", false, ch.index, ch.title, ch.text, scriptFingerprint({ style: "细腻", compressNarration: true, cardsFp: "def456" }));
  assert(file !== other, "cardsFp 变化必须改变剧本缓存文件名");

  // 3. 防漂移：src 内不得出现漏传 cardsFp 的手工 scriptFingerprint 字面量
  const root = join(process.cwd(), "src");
  const offenders: string[] = [];
  for (const file2 of collectTs(root)) {
    const src = readFileSync(file2, "utf8");
    // 形如 scriptFingerprint({ ... }) 的对象字面量调用
    const re = /scriptFingerprint\s*\(\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const body = m[1];
      if (body.includes("style") && !body.includes("cardsFp")) {
        offenders.push(`${file2.slice(root.length + 1)} :: scriptFingerprint({${body.trim()}})`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `发现漏传 cardsFp 的手工剧本指纹（会造成写读键不一致）：\n  ${offenders.join("\n  ")}\n请改用 this.scriptStyleFrag() 或补齐 cardsFp。`,
  );

  console.log("=== 剧本缓存键一致性测试通过 ===");
}

main();
