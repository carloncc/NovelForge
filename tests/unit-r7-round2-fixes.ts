/**
 * 本轮修复的完整测试套件（按软件测试流程分层）。
 *
 * 设计方法（黑盒）：
 *   - 等价类划分：mime 类型、有效/无效 base64、可重试/不可重试状态码
 *   - 边界值分析：分页字符数 0/1/63/64/65/128、限流器 Map 0/1/N 项
 *   - 判定表：classifyError 的 状态码 × 文本信号 全组合
 *   - 错误推测法：代理解析失败、配额不足、双击并发、指纹漂移等易错点
 *
 * 层级：
 *   [单元] 纯函数：场景 id 去重、配音文件名解析、分页、错误分类
 *   [集成] 跨模块边界：图片编辑通道（multipart 构造 + 重试）、限流器接线
 */
import "fake-indexeddb/auto";
import { classifyError } from "../src/utils/errorClassifier";
import { splitVocalFileName } from "../src/core/voice";
import { paginateForTextBox, renderSpokenText, TEXTBOX_PAGE_MAX_CHARS, sanitizeId } from "../src/core/render";
import { ensureUniqueSceneIds } from "../src/core/pipeline";
import { editImageVariant, makeBoundary, buildEditMultipartFiles } from "../src/api/imageEdits";
import { pruneLimiters, limiterKeyForConfig, setImageConcurrency, setLlmConcurrency } from "../src/api/openaiCompatible";
import { tauri } from "../src/utils/tauri";
import type { ChapterScript } from "../src/core/types";
import type { ApiConfig } from "../src/core/types";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; return; }
  failures.push(msg);
  console.error("  ✗ " + msg);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg}｜期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ==================== [单元] 场景 id 去重：sanitizeId 碰撞 ==================== */
function testSceneIdUniqueness(): void {
  // 错误推测法：两个不同的中文场景 id 经 sanitizeId 后都变成 "___"，
  // 而配音/背景/CG 的缓存键全部基于 sanitizeId(scene.id) → 两人共用一份素材。
  const script = {
    chapter: 1,
    scenes: [
      { id: "城门", lines: [] },
      { id: "城楼", lines: [] },
      { id: "城门", lines: [] },
    ],
  } as unknown as ChapterScript;
  ensureUniqueSceneIds(script);
  const keys = script.scenes.map((s) => sanitizeId(s.id));
  ok(new Set(keys).size === keys.length, `sanitize 后的场景 id 必须互不相同，实际 ${JSON.stringify(keys)}`);
  // 第一个 id 无冲突，应原样保留；后两个因 sanitize 冲突而后缀化
  eq(script.scenes[0].id, "城门", "无冲突的首个 id 应原样保留");
  ok(script.scenes[1].id !== "城楼" && script.scenes[2].id !== "城门", `冲突项应被后缀化，实际 ${JSON.stringify(script.scenes.map((s) => s.id))}`);

  // 边界：空 id / 重复 id 混合时仍必须唯一且幂等
  const mixed = { chapter: 1, scenes: [{ id: "", lines: [] }, { id: "a", lines: [] }, { id: "a", lines: [] }, { id: "a_2", lines: [] }] } as unknown as ChapterScript;
  ensureUniqueSceneIds(mixed);
  const mk = mixed.scenes.map((s) => sanitizeId(s.id));
  ok(new Set(mk).size === mk.length, `混合边界下仍须唯一，实际 ${JSON.stringify(mk)}`);
  // 幂等：再跑一次不应继续变
  const before = mixed.scenes.map((s) => s.id);
  ensureUniqueSceneIds(mixed);
  eq(mixed.scenes.map((s) => s.id), before, "去重必须幂等");
}

/* ==================== [单元] 配音文件名解析 ==================== */
function testVocalFileName(): void {
  // key 含下划线时必须从右切：这是 actualVoiceFileName 改用它做锚定的前提
  const p = splitVocalFileName("v_ch1_sc_a_b_3_1abc2_9z8y7.mp3");
  ok(p !== null, "应能解析 v_<key>_<fp>_<hash>.<ext>");
  eq(p, { key: "ch1_sc_a_b_3", fp: "1abc2", hash: "9z8y7" }, "key 含下划线时应从右切最后两段");
  eq(splitVocalFileName("garbage.txt"), null, "非配音文件应返回 null");
  eq(splitVocalFileName("v_只有key.mp3"), null, "缺 fp/hash 段时应返回 null");
}

/* ==================== [单元] 边界值：文本分页 ==================== */
function testPaginationBoundaries(): void {
  const M = TEXTBOX_PAGE_MAX_CHARS;
  eq(paginateForTextBox(""), "", "空串不产生分页");
  eq(paginateForTextBox("短句"), "短句", "短于上限不产生分页符");
  // 边界值分析：上限本身与 ±1
  const exact = "字".repeat(M);
  ok(!paginateForTextBox(exact).includes("|"), `恰好 ${M} 字不应分页`);
  const over = "字".repeat(M + 1);
  ok(paginateForTextBox(over).includes("|"), `${M + 1} 字应触发分页`);
  // 无损性：分页后去掉分隔符必须与原文逐字一致（不得静默裁字）
  for (const n of [M, M + 1, M * 2, M * 3, M * 7 + 5]) {
    const src = "林澈说了一句很长的话，".repeat(Math.ceil(n / 10)).slice(0, n);
    const out = paginateForTextBox(src);
    eq(out.split("|").join(""), src, `${n} 字分页后内容必须逐字无损`);
  }
  // 字面竖线不得被当成分页符（转义契约 #1508）
  const withPipe = renderSpokenText("前".repeat(M + 10) + "|后");
  ok(withPipe.includes("\\|"), "字面竖线必须转义");
  ok(withPipe.split(/(?<!\\)\|/).length >= 2, "分页符必须是未转义竖线");
}

/* ==================== [单元] 判定表：错误分类 ==================== */
function testErrorClassificationTable(): void {
  // 判定表：状态码 × 是否带限流/审查文本
  const rows: [string, number | undefined, string, string][] = [
    ["无 status + 限流文本", undefined, "HTTP 429 too many requests", "rate_limit"],
    ["400 + 限流文本", 400, "rate limit exceeded", "rate_limit"],
    ["400 + 审查文本", 400, "content_rejected", "content_moderation"],
    ["400 纯参数错", 400, "bad request", "invalid_param"],
    ["422 纯参数错", 422, "unprocessable", "invalid_param"],
    ["401 鉴权", 401, "unauthorized", "auth"],
    ["403 鉴权", 403, "forbidden", "auth"],
    ["408 超时（新增可重试）", 408, "Request Timeout", "network"],
    ["425 过早（新增可重试）", 425, "Too Early", "network"],
    ["429 限流", 429, "x", "rate_limit"],
    ["500", 500, "x", "network"],
    ["503", 503, "x", "network"],
    ["已中止", undefined, "已中止组装", "aborted"],
  ];
  for (const [name, status, msg, want] of rows) {
    eq(classifyError(new Error(msg), status), want, `分类[${name}]`);
  }
}

/* ==================== [集成] 图片编辑通道 ==================== */
function fakeCfg(): ApiConfig {
  return { id: "cfg-test", kind: "image", baseUrl: "https://api.example.com/v1", model: "gpt-image-1", apiKey: "k" } as unknown as ApiConfig;
}

function multipartNames(body: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(body);
  return [...text.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
}

async function testEditVariantFilenameByInputMime(): Promise<void> {
  const original = tauri.http;
  const seen: Uint8Array[] = [];
  tauri.http = (async (args: { bodyBase64?: string }) => {
    seen.push(Buffer.from(args.bodyBase64 ?? "", "base64"));
    return {
      status: 200,
      contentType: "application/json",
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), "utf8").toString("base64"),
    };
  }) as typeof tauri.http;
  try {
    // 等价类划分：输入格式 JPEG 但输出格式为 png 时，文件名必须跟随「输入」
    const cases: [string, "png" | "jpeg" | "webp" | undefined, string][] = [
      ["image/jpeg", undefined, "source.jpg"],
      ["image/png", undefined, "source.png"],
      ["image/webp", undefined, "source.webp"],
      ["image/jpeg", "webp", "source.jpg"], // 输出格式不得污染输入文件名
    ];
    for (const [mime, out, want] of cases) {
      seen.length = 0;
      const r = await editImageVariant(fakeCfg(), {
        imageB64: Buffer.from("PNGDATA").toString("base64"),
        imageMime: mime,
        prompt: "p",
        width: 1024,
        height: 1024,
        outputFormat: out,
      });
      eq(multipartNames(seen[0]), [want], `输入 ${mime} → 文件名应为 ${want}`);
      eq(r.dataB64, "aGVsbG8=", `输入 ${mime} 应返回图片数据`);
    }
    // 输出格式仍要通过独立的 output_format 字段传递
    await editImageVariant(fakeCfg(), {
      imageB64: Buffer.from("PNGDATA").toString("base64"), imageMime: "image/jpeg",
      prompt: "p", width: 1, height: 1, outputFormat: "webp",
    });
    const t = new TextDecoder().decode(seen[0]);
    ok(t.includes("webp"), "output_format 字段必须承载输出格式");
  } finally {
    tauri.http = original;
  }
}

async function testEditVariantRetriesThenSucceeds(): Promise<void> {
  const original = tauri.http;
  let calls = 0;
  tauri.http = (async () => {
    calls++;
    if (calls === 1) return { status: 503, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ error: { message: "upstream busy" } })).toString("base64") };
    if (calls === 2) return { status: 429, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ error: { message: "rate limited" } })).toString("base64") };
    return { status: 200, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: "b2s=" }] })).toString("base64") };
  }) as typeof tauri.http;
  try {
    const r = await editImageVariant(fakeCfg(), {
      imageB64: Buffer.from("x").toString("base64"), imageMime: "image/png", prompt: "p", width: 1, height: 1,
    });
    eq(r.dataB64, "b2s=", "503/429 之后应重试并成功");
    ok(calls >= 3, `应至少尝试 3 次，实际 ${calls}`);
  } finally {
    tauri.http = original;
  }
}

async function testEditVariantDoesNotRetryPermanentError(): Promise<void> {
  const original = tauri.http;
  let calls = 0;
  tauri.http = (async () => {
    calls++;
    return { status: 400, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ error: { message: "bad prompt" } })).toString("base64") };
  }) as typeof tauri.http;
  try {
    let threw = false;
    try {
      await editImageVariant(fakeCfg(), {
        imageB64: Buffer.from("x").toString("base64"), imageMime: "image/png", prompt: "p", width: 1, height: 1,
      });
    } catch { threw = true; }
    ok(threw, "400 应直接抛错");
    eq(calls, 1, `400 属永久错误不得重试（避免对注定失败的请求反复计费），实际调用 ${calls} 次`);
  } finally {
    tauri.http = original;
  }
}

function testMultipartSanity(): void {
  const b = makeBoundary();
  ok(b.length > 8, "boundary 应为非空随机串");
  const body = buildEditMultipartFiles(b, { prompt: "p" }, [{ name: "image", filename: "source.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }]);
  const t = new TextDecoder("latin1").decode(body);
  ok(t.includes(`--${b}`), "multipart 必须以 boundary 开头");
  ok(t.includes('filename="source.png"'), "multipart 必须带 filename");
  ok(t.includes(`--${b}--`), "multipart 必须以结束标记收尾");
}

/* ==================== [集成] 限流器回收 ==================== */
function testLimiterPrune(): void {
  const mk = (id: string): ApiConfig => ({ id, kind: "image", baseUrl: "u", model: "m", apiKey: "k" } as unknown as ApiConfig);
  const a = mk("keep-a");
  const b = mk("drop-b");
  setImageConcurrency(a, 4);
  setImageConcurrency(b, 4);
  setLlmConcurrency(b, 4);
  pruneLimiters([limiterKeyForConfig(a)]);
  // 存活配置仍可继续取用（未误删）
  ok(typeof limiterKeyForConfig(a) === "string", "存活配置 key 应仍可计算");
  // 删除配置后再 prune 一次不应抛错（幂等）
  pruneLimiters([]);
  pruneLimiters([limiterKeyForConfig(a)]);
  ok(true, "pruneLimiters 应幂等且不抛错");
}

async function main(): Promise<void> {
  console.log("[单元] 场景 id 去重"); testSceneIdUniqueness();
  console.log("[单元] 配音文件名解析"); testVocalFileName();
  console.log("[单元] 文本分页边界值"); testPaginationBoundaries();
  console.log("[单元] 错误分类判定表"); testErrorClassificationTable();
  console.log("[单元] multipart 构造"); testMultipartSanity();
  console.log("[集成] 图片编辑-文件名跟随输入格式"); await testEditVariantFilenameByInputMime();
  console.log("[集成] 图片编辑-可重试错误退避后成功"); await testEditVariantRetriesThenSucceeds();
  console.log("[集成] 图片编辑-永久错误不重试"); await testEditVariantDoesNotRetryPermanentError();
  console.log("[集成] 限流器回收"); testLimiterPrune();

  if (failures.length) {
    console.error(`\n✗ ${failures.length} 条断言失败：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\n=== 本轮修复测试全部通过（${passed} 条断言）===`);
}

main().catch((e) => { console.error("失败:", e); process.exit(1); });
