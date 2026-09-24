// 校验 4 语言字典：键集一致（缺翻/多翻）+ 值质量（伪翻译/空值）。
// 伪翻译口径：值等于键且键含 CJK（切语言后仍显示中文，即“切了像没切”）。
//   - ja/ko/en：强制检测，仅 COMMON_EQUAL_ALLOW 例外（语言自称等确无需翻译者）；
//   - zh-TW：白名单制，COMMON_EQUAL_ALLOW + ZHTW_EQUAL_ALLOW（简繁同形、已逐条核对）除外。
// 空值口径：值去空白后为空串一律失败（EMPTY_EQUAL_ALLOW 预留显式白名单，目前为空）。
import { readFileSync } from "node:fs";

const KEYS = readFileSync("scripts/i18n-keys.txt", "utf-8").split("\n").map((key) => key.trimEnd()).filter(Boolean);
const uniq = [...new Set(KEYS)].sort();
const files = ["zh-TW", "en", "ja", "ko"];

const CJK_RE = /[一-鿿㐀-䶿]/;

// 值等于键也合法的例外：语言自称，以及汉日/简繁同形词（各语言共用原文即正确）。
const COMMON_EQUAL_ALLOW = new Set(["日本語", "操作"]);

// zh-TW 简繁同形白名单：繁体写法与简体键完全一致，已逐条核对（#1142）。
// 英文示例原文（`例：unified …`）各语言共用，不翻译。
const ZHTW_EQUAL_ALLOW = new Set([
  "完成",
  "PC 端 exe",
  "人物",
  "例：unified Japanese anime style, cel shading, clean line art",
  "停止",
  "正在停止…",
  "全部角色",
  "分章",
  "固定 seed",
  "外貌",
  "姓名",
  "性格",
  "提取卡片",
  "放入",
  "放大",
  "映射到（角色/物品 id）",
  "清空",
  "清除",
  "物品",
  "移除",
  "素材",
  "繁體中文",
  "背景",
  "逐句配音",
  "配音",
  "重新配音（全部）",
  "重配",
  "音色描述",
  "TTS 配音",
  "⏸ 停止",
  "」全部",
  "使用中",
  "共",
  "可映射 id：角色",
  "已完成",
  "已知模型能力：最多",
  "打包 zip",
  "打包中…",
  "章",
  "第",
  "缺失素材",
  "草稿",
  "表情差分（5 表情/角色）",
  "警告",
  "配音（TTS）",
  "重配「",
  "不限制",
  "重新生成描述",
  "生成本章",
  "停用",
  "AI 分章",
  "TTS 音色",
  "不使用封面",
  "不播放",
  "先提取卡片",
  "全量",
  "分章：AI",
  "分章：尚未分章",
  "取消",
  "另有",
  "含配音",
  "女",
  "存疑",
  "忽略",
  "情感",
  "接受：改成",
  "提取分段",
  "旁白",
  "未命名",
  "模型",
  "男",
  "知道了",
  "缺配音",
  "表情差分",
  "配音：",
  "重跑",
  "音量",
  "正常：{reply}",
  "提取",
  "未命名作品",
  "每章上限（0=不限）",
  "只看未完成",
  "全量重跑",
  "查看全部",
  "已停用",
  "重跑配音",
  "修改素材映射",
  "移除素材",
]);

// 允许为空值的显式白名单（目前无：空值一律失败）
const EMPTY_ALLOW = new Set();

function parseDict(src) {
  const map = new Map();
  const keys = [];
  const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gm;
  let m;
  while ((m = re.exec(src))) {
    const k = m[1] ?? m[2];
    const v = m[3] ?? m[4];
    keys.push(k);
    if (!map.has(k)) map.set(k, v);
  }
  return { keys, map };
}

let failed = false;
for (const f of files) {
  const src = readFileSync(`src/i18n/${f}.ts`, "utf-8");
  const { keys: dictKeys, map } = parseDict(src);
  const missing = uniq.filter((k) => !dictKeys.includes(k));
  const extra = dictKeys.filter((k) => !uniq.includes(k));
  if (missing.length || extra.length) {
    failed = true;
    console.log(`[${f}] 缺 ${missing.length}:`, missing.slice(0, 10));
    console.log(`[${f}] 多 ${extra.length}:`, extra.slice(0, 10));
  } else {
    console.log(`[${f}] ✓ ${dictKeys.length} 条齐全`);
  }

  // 空值检测（全部语言强制）
  const empty = [...map.entries()].filter(([k, v]) => v.trim() === "" && !EMPTY_ALLOW.has(k)).map(([k]) => k);
  if (empty.length) {
    failed = true;
    console.log(`[${f}] ✗ 空值 ${empty.length}:`, empty.slice(0, 10));
  }

  // 伪翻译检测：值等于键且键含 CJK
  const allow = f === "zh-TW" ? new Set([...COMMON_EQUAL_ALLOW, ...ZHTW_EQUAL_ALLOW]) : COMMON_EQUAL_ALLOW;
  const pseudo = [...map.entries()].filter(([k, v]) => v === k && CJK_RE.test(k) && !allow.has(k)).map(([k]) => k);
  if (pseudo.length) {
    failed = true;
    console.log(`[${f}] ✗ 伪翻译 ${pseudo.length}:`, pseudo.slice(0, 15));
  } else {
    console.log(`[${f}] ✓ 无伪翻译/空值`);
  }
}
if (failed) process.exit(1);
