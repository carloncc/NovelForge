// 校验 4 语言字典：键集一致（缺翻/多翻）+ 值质量（伪翻译/空值）。
// 伪翻译口径：值等于键且键含 CJK（切语言后仍显示中文，即“切了像没切”）。
//   - ja/ko/en：强制检测，仅 COMMON_EQUAL_ALLOW 例外（语言自称等确无需翻译者）；
//   - zh-TW：白名单制，COMMON_EQUAL_ALLOW + ZHTW_EQUAL_ALLOW（简繁同形、已逐条核对）除外。
// 空值口径：值去空白后为空串一律失败（EMPTY_EQUAL_ALLOW 预留显式白名单，目前为空）。
import { readFileSync, readdirSync } from "node:fs";
import { extname } from "node:path";

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
  // 「全部」简繁同形，与既有「全部角色」同例
  "全部",
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
  // 章节序数：繁体与简体的写法本就相同（"第 1 章"/"第 1 章：标题" 两语言一致）
  "第 {n} 章",
  "第 {n} 章 {title}",
  // 分章操作：简繁同形（分章操作 的繁体写法不变）
  "分章操作",
  // 日志阶段徽标：简繁同形（追加/中止/提示 在繁体里写法不变）
  "追加",
  "中止",
  "提示",
  // 配音章节号双标注：原文/第/章/标题 繁体与简体同形
  "（原文第 {n} 章 {title}）",
  // 角色图片档位：主要角色/次要角色/路人 的繁体写法与简体完全同形（"角色/路人"不变）
  "主要角色（全量）",
  "次要角色",
  "路人",
]);

// 日文汉字与中文同形即正确（不是"没翻译"）：日文的「追加」「中止」「画像認識」等
// 本就写作汉字，值等于键属预期结果，#1476 补键时逐条核对过。
// 配音章节号双标注「（原文第 {n} 章 {title}）」同理：原文第/章/标题 全是汉字写法。
const JA_EQUAL_ALLOW = new Set(["追加", "中止", "（原文第 {n} 章 {title}）"]);

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
  const allow =
    f === "zh-TW"
      ? new Set([...COMMON_EQUAL_ALLOW, ...ZHTW_EQUAL_ALLOW])
      : f === "ja"
        ? new Set([...COMMON_EQUAL_ALLOW, ...JA_EQUAL_ALLOW])
        : COMMON_EQUAL_ALLOW;
  const pseudo = [...map.entries()].filter(([k, v]) => v === k && CJK_RE.test(k) && !allow.has(k)).map(([k]) => k);
  if (pseudo.length) {
    failed = true;
    console.log(`[${f}] ✗ 伪翻译 ${pseudo.length}:`, pseudo.slice(0, 15));
  } else {
    console.log(`[${f}] ✓ 无伪翻译/空值`);
  }
}

/* ---------- #1512：源码覆盖率 ----------
 * 原有校验只做「字典 ↔ i18n-keys.txt」的内部一致性，从不读 src/。
 * 于是 t("新文案") 写进组件却忘了补字典时，门禁照样全绿，
 * 而 t() 的缺翻译回退（src/i18n/index.ts: dict[key] ?? key）会让 en/ja/ko/zh-TW
 * 直接显示简体中文——正是本脚本注释里说的「切了像没切」。
 * 这里补一层源码扫描，并把 JSDoc 用法示例里的 t("…") 排除掉（不是真实调用）。
 */
function walkSrc(dir, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkSrc(p, out);
    else if ([".ts", ".vue"].includes(extname(e.name))) out.push(p);
  }
}

/** 单趟扫描：跳过字符串/行注释/块注释，只在真实代码里抓 t("…") / t('…') 字面量。
 *  必须区分「字符串里的 //」与真注释——否则 "https://…" 之后整行被当成注释。 */
function collectSourceKeys(files) {
  const found = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    let i = 0;
    const n = src.length;
    let quote = null;
    while (i < n) {
      const c = src[i];
      if (quote) {
        if (c === "\\") { i += 2; continue; }
        if (c === quote) { quote = null; i++; continue; }
        // #1574：Vue 模板属性值形如 :title="`${name}${t('文案')}`" —— 整段被外层双引号吞进
        // 「字符串」状态，上面的字面量分支永远看不到它。于是「用了新文案却忘补字典」在这类
        // 位置可以一路绿灯（实测盲区 81 条：1004/1085）。这里在引号内部补一次检测，
        // 内层引号必与外层不同（外层 " 包裹 t('…')；反之亦然），据此避免误吞。
        if (c === "t" && src[i + 1] === "(" && !/[A-Za-z0-9_$]/.test(src[i - 1] || "")) {
          let j = i + 2;
          while (j < n && /\s/.test(src[j])) j++;
          const inner = src[j];
          if ((inner === "\"" || inner === "'") && inner !== quote) {
            let k = j + 1;
            let val = "";
            while (k < n) {
              if (src[k] === "\\") { val += src[k] + src[k + 1]; k += 2; continue; }
              if (src[k] === inner) break;
              val += src[k];
              k++;
            }
            found.add(val);
            i = k + 1;
            continue;
          }
        }
        i++;
        continue;
      }
      if (c === "\"" || c === "'") { quote = c; i++; continue; }
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "t" && (src[i + 1] === "(") && !/[A-Za-z0-9_$]/.test(src[i - 1] || "")) {
        let j = i + 2;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === "\"" || q === "'") {
          let k = j + 1;
          let val = "";
          while (k < n) {
            if (src[k] === "\\") { val += src[k] + src[k + 1]; k += 2; continue; }
            if (src[k] === q) break;
            val += src[k];
            k++;
          }
          found.add(val);
          i = k + 1;
          continue;
        }
      }
      i++;
    }
  }
  return found;
}

const srcFiles = [];
walkSrc("src", srcFiles);
const usedKeys = collectSourceKeys(srcFiles);
const uncovered = [...usedKeys].filter((k) => !uniq.includes(k)).sort();
if (uncovered.length) {
  failed = true;
  console.log(`[src] ✗ ${uncovered.length} 条 t() 文案未进字典（en/ja/ko/zh-TW 会显示中文原文）:`);
  for (const k of uncovered) console.log("   -", JSON.stringify(k));
} else {
  console.log(`[src] ✓ ${usedKeys.size} 条 t() 文案全部有字典条目`);
}
if (failed) process.exit(1);
