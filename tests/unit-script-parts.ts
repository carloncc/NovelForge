/**
 * P1 分段落盘/断点续跑 + P2 段间连贯：
 * - 段缓存命名/解析/扫描纯函数（命中/过期/忽略口径）
 * - 上一段结尾提取（8~12 行）/id 收集/note 组装纯函数
 * - 端到端（stub tauri.http + 真实 tmp 目录）：逐段落盘、断点续跑零调用、
 *   指纹变化清理旧段、单段不写段文件、多段 scene id 唯一、k>1 带衔接后缀
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tauri } from "../src/utils/tauri";
import {
  isScriptPartFileName,
  parseScriptPartFileName,
  scanScriptPartCache,
  scriptPartFileName,
  scriptPartRest,
} from "../src/core/cache";
import {
  buildPrevPartNote,
  collectPrevPartIds,
  extractPrevPartTail,
  PREV_PART_TAIL_LINES,
  scriptChapter,
} from "../src/core/script";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) 段缓存命名与指纹 ---------- */
const restA = scriptPartRest("第一章", "正文正文", "", undefined);
assert(typeof restA === "string" && restA.length > 0, "段 rest 应非空");
assert(scriptPartRest("第一章", "正文正文", "", undefined) === restA, "同输入 rest 必须稳定");
assert(scriptPartRest("第一章", "正文正文", "", "换个写法") !== restA, "意见变化必须换 rest（不能复用上一版的段）");
assert(scriptPartRest("第一章", "正文正文改", "", undefined) !== restA, "正文变化必须换 rest");
assert(scriptPartRest("第一章", "正文正文", "_stX", undefined) !== restA, "风格指纹变化必须换 rest");

const partName = scriptPartFileName("cache", false, 2, "第三章", "正文", "_stX", undefined, 2, 4).split("/").pop()!;
assert(isScriptPartFileName(partName), `段文件名应被识别：${partName}`);
assert(!isScriptPartFileName("script_ch3_abc123.json"), "整章缓存文件名不得被当成段文件");
const parsed = parseScriptPartFileName(partName);
assert(parsed !== null, "段文件名应能解析");
assert(parsed!.demo === false && parsed!.chapterPos === 2 && parsed!.part === 2 && parsed!.total === 4, "段文件名解析字段错误");
assert(parsed!.rest === scriptPartRest("第三章", "正文", "_stX", undefined), "段文件名 rest 应与公式一致");
const demoParsed = parseScriptPartFileName("script_demo_ch1_part1of2_r.json");
assert(demoParsed !== null && demoParsed.demo === true, "demo 段文件名前缀应能解析");
assert(parseScriptPartFileName("script_ch1_abc.json") === null, "整章文件名解析应返回 null");

/* ---------- 2) 段缓存扫描：命中/过期/忽略 ---------- */
{
  const entries = [
    { name: "script_ch1_part1of2_restA.json", path: "c/script_ch1_part1of2_restA.json" },
    { name: "script_ch1_part2of2_restA.json", path: "c/script_ch1_part2of2_restA.json" },
    { name: "script_ch1_part1of2_restOLD.json", path: "c/script_ch1_part1of2_restOLD.json" },
    { name: "script_ch1_part1of3_restA.json", path: "c/script_ch1_part1of3_restA.json" },
    { name: "script_ch2_part1of2_restA.json", path: "c/script_ch2_part1of2_restA.json" },
    { name: "script_demo_ch1_part1of2_restA.json", path: "c/script_demo_ch1_part1of2_restA.json" },
    { name: "script_ch1_restA.json", path: "c/script_ch1_restA.json" },
    { name: "cards.json", path: "c/cards.json" },
  ];
  const scan = scanScriptPartCache(entries, 0, false, "restA", 2);
  assert(scan.hits.size === 2, `应命中 2 段，实际 ${scan.hits.size}`);
  assert(scan.hits.get(1) === "c/script_ch1_part1of2_restA.json", "第 1 段命中路径错误");
  assert(scan.hits.get(2) === "c/script_ch1_part2of2_restA.json", "第 2 段命中路径错误");
  // 过期：同章但 rest 失配 / 总数失配；别章、demo、整章文件、非段文件一律忽略（不删）
  assert(scan.stale.length === 2, `应有 2 个过期段（旧 rest + 总数变化），实际 ${scan.stale.length}`);
  assert(scan.stale.includes("c/script_ch1_part1of2_restOLD.json"), "旧 rest 段应判过期");
  assert(scan.stale.includes("c/script_ch1_part1of3_restA.json"), "总数变化的段应判过期");
}

/* ---------- 3) P2：上一段结尾提取 / id 收集 / note ---------- */
assert(PREV_PART_TAIL_LINES >= 8 && PREV_PART_TAIL_LINES <= 12, "默认结尾行数应在 8~12 行内");
{
  const mkLines = (n: number) =>
    Array.from({ length: n }, (_, k) => (
      k % 2 === 0
        ? { type: "dialogue" as const, characterId: "c1", text: `台词${k}` }
        : { type: "narration" as const, text: `旁白${k}` }
    ));
  const scenes = [
    { id: "s1", lines: mkLines(9) },
    { id: "s2", lines: mkLines(6) },
  ] as never;
  const tail = extractPrevPartTail(scenes);
  assert(tail.length === 10, `默认应取最后 10 行，实际 ${tail.length}`);
  assert(tail[0].includes("旁白5") || tail[0].includes("台词"), "应为连续结尾行");
  assert(tail[tail.length - 1].endsWith("旁白5"), "最后一行应是原文结尾");
  assert(tail.some((t) => t.startsWith("c1：")), "对话行应带说话人 id");
  assert(tail.some((t) => t.startsWith("旁白：")), "旁白行应带旁白前缀");
  assert(extractPrevPartTail(scenes, 99).length === 12, "上限应钳在 12 行");
  assert(extractPrevPartTail(scenes, 1).length === 8, "下限应钳在 8 行");
  assert(extractPrevPartTail([{ id: "s", lines: mkLines(3) }] as never).length === 3, "不足 N 行时应全取");
  assert(extractPrevPartTail([]).length === 0, "空场景应返回空数组");

  const withChoices = [
    {
      id: "s1",
      lines: [{ type: "dialogue", characterId: "c1", text: "走。" }],
      choices: [{ id: "q1", prompt: "追", lines: [{ type: "dialogue", characterId: "c2", text: "等等。" }] }],
    },
  ] as never;
  const ids = collectPrevPartIds(withChoices);
  assert(ids.sceneIds.join(",") === "s1", "场景 id 收集错误");
  assert(ids.characterIds.includes("c1") && ids.characterIds.includes("c2"), "分支台词角色也应计入已出场");

  const note = buildPrevPartNote(["c1：走。", "旁白：夜风起。"], ["s1"], ["c1"]);
  assert(note.includes("上一段结尾"), "note 应含结尾标记");
  assert(note.includes("c1：走。"), "note 应含结尾原文");
  assert(note.includes("s1"), "note 应含已用 scene id");
  assert(note.includes("不得与上述已用 id 重复"), "note 应要求 scene id 不重复");
  assert(buildPrevPartNote([], ["s1"], ["c1"]) === "", "无结尾行时 note 应为空（不拼后缀）");
}

/* ---------- 4) 端到端：落盘 / 续跑 / 过期清理 / 单段干净 ---------- */
const DIR = (await mkdtemp(join(tmpdir(), "novelforge-script-parts-"))).replace(/\\/g, "/");
const cacheDir = `${DIR}/cache`;
const cfg = {
  id: "test-llm",
  model: "test-model",
  baseUrl: "https://example.com/v1",
  apiKey: "test-key",
  extra: { contextLength: 8192 },
} as never;
const cards = {
  characters: [{ id: "c1", name: "林澈" }],
  scenes: [],
  items: [],
} as never;

let httpCalls = 0;
let bodies: string[] = [];
const originalHttp = tauri.http;
tauri.http = (async (args: { body?: string }) => {
  httpCalls++;
  if (typeof args.body === "string") bodies.push(args.body);
  const n = httpCalls;
  const payload = {
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: `地点${n}`,
        atmosphere: "夜",
        time: "夜",
        bgPrompt: "anime background, night street, no people",
        lines: [
          { type: "dialogue", characterId: "c1", text: `第${n}次调用台词。` },
          { type: "narration", text: `第${n}次调用旁白。` },
        ],
      },
    ],
  };
  const text = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
  return { status: 200, contentType: "application/json", bodyBase64: Buffer.from(text, "utf-8").toString("base64") };
}) as typeof tauri.http;

const para = "林澈拔剑，剑光如雪，夜风骤起吹动衣袂。\n\n";
const longText = para.repeat(900); // 约 2 万字：小上下文模型必分多段
const chapter = { index: 0, title: "第一章", text: longText } as never;

// 第一次：全量生成，每段立即落盘
const logs1: string[] = [];
const done1: { part: number; total: number }[] = [];
const run1 = await scriptChapter(cfg, chapter, cards, undefined, {
  partCache: { cacheDir, demo: false, styleFrag: "" },
  onLog: (m) => logs1.push(m),
  onPart: (i) => {
    if (i.phase === "done") done1.push({ part: i.part, total: i.total });
  },
});
const total = done1.length > 0 ? done1[0].total : 0;
assert(total > 1, `长章节应分多段生成，实际 total=${total}`);
assert(httpCalls === total, `首次应逐段调用 ${total} 次，实际 ${httpCalls}`);
assert(run1.scenes.length === total, `每段 1 场景，合并应有 ${total} 个场景，实际 ${run1.scenes.length}`);
const partFiles1 = (await tauri.listDir(cacheDir)).filter((e) => isScriptPartFileName(e.name));
assert(partFiles1.length === total, `段文件应有 ${total} 个，实际 ${partFiles1.length}`);
const tmpLeft1 = (await tauri.listDir(cacheDir)).filter((e) => e.name.endsWith(".tmp"));
assert(tmpLeft1.length === 0, "原子写不应残留 .tmp 文件");
// 多段 scene id 唯一（两段 raw id 都是 s1，映射后不得撞）
assert(new Set(run1.scenes.map((s) => s.id)).size === run1.scenes.length, "多段 scene id 必须唯一");
// P2：首段不带衔接后缀，第 2 段起带上
const userOf = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { messages?: { content?: string }[] };
    return parsed.messages?.[1]?.content ?? "";
  } catch {
    return "";
  }
};
assert(bodies.length === total, "请求体捕获数量应与段数一致");
assert(!userOf(bodies[0]).includes("上一段结尾"), "首段不应带衔接后缀");
assert(userOf(bodies[1]).includes("上一段结尾"), "第 2 段应带上一段结尾");
assert(userOf(bodies[1]).includes("已用场景 id"), "第 2 段应带已用 scene id 列表");

// 第二次：断点续跑，全命中零调用
httpCalls = 0;
bodies = [];
const logs2: string[] = [];
const run2 = await scriptChapter(cfg, chapter, cards, undefined, {
  partCache: { cacheDir, demo: false, styleFrag: "" },
  onLog: (m) => logs2.push(m),
});
assert(httpCalls === 0, `全命中时不应再调模型，实际调用 ${httpCalls} 次`);
assert(run2.scenes.length === run1.scenes.length, "续跑合并场景数应一致");
assert(JSON.stringify(run2.scenes) === JSON.stringify(run1.scenes), "续跑结果应与首次逐字一致（含 scene id 去重与配额）");
const hitLogs = logs2.filter((m) => m.includes("命中缓存，跳过"));
assert(hitLogs.length === total, `每段都应打命中缓存日志，实际 ${hitLogs.length}/${total}`);

// 第三次：正文变化 → 旧段清理后重跑
httpCalls = 0;
const logs3: string[] = [];
const changed = { index: 0, title: "第一章", text: `${longText}尾声。` } as never;
const run3 = await scriptChapter(cfg, changed, cards, undefined, {
  partCache: { cacheDir, demo: false, styleFrag: "" },
  onLog: (m) => logs3.push(m),
});
assert(httpCalls === total, `指纹变化后应重跑全部 ${total} 段，实际 ${httpCalls}`);
assert(logs3.some((m) => m.includes("段缓存已失效") && m.includes("已清理")), "指纹变化应打清理日志");
const partFiles3 = (await tauri.listDir(cacheDir)).filter((e) => isScriptPartFileName(e.name));
assert(partFiles3.length === total, `清理后段文件应仍为 ${total} 个新文件，实际 ${partFiles3.length}`);
assert(run3.scenes.length === total, "重跑后合并场景数应一致");

// 第四次：单段章节行为一致，不多写段文件
httpCalls = 0;
const shortChapter = { index: 5, title: "短章", text: "林澈拔剑。夜风起。\n\n收剑回鞘。" } as never;
const run4 = await scriptChapter(cfg, shortChapter, cards, undefined, {
  partCache: { cacheDir, demo: false, styleFrag: "" },
});
assert(httpCalls === 1, `单段章节应只调 1 次，实际 ${httpCalls}`);
assert(run4.scenes.length > 0, "单段章节应正常产出场景");
const shortParts = (await tauri.listDir(cacheDir)).filter((e) => e.name.includes("_ch6_") && isScriptPartFileName(e.name));
assert(shortParts.length === 0, "单段章节不得写段文件");

tauri.http = originalHttp;
await tauri.removePath(DIR).catch(() => {});

console.log("=== script parts tests passed ===");
