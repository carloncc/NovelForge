// 校验 4 语言字典与基准 key 集一致（缺翻/多翻检测）
import { readFileSync } from "node:fs";
const KEYS = readFileSync("scripts/i18n-keys.txt", "utf-8").split("\n").filter(Boolean);
const uniq = [...new Set(KEYS)].sort();
const files = ["zh-TW", "en", "ja", "ko"];
let failed = false;
for (const f of files) {
  const src = readFileSync(`src/i18n/${f}.ts`, "utf-8");
  const dictKeys = [...src.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
  const missing = uniq.filter((k) => !dictKeys.includes(k));
  const extra = dictKeys.filter((k) => !uniq.includes(k));
  if (missing.length || extra.length) {
    failed = true;
    console.log(`[${f}] 缺 ${missing.length}:`, missing.slice(0, 10));
    console.log(`[${f}] 多 ${extra.length}:`, extra.slice(0, 10));
  } else {
    console.log(`[${f}] ✓ ${dictKeys.length} 条齐全`);
  }
}
if (failed) process.exit(1);
