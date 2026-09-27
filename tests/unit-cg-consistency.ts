/**
 * 立绘版 CG 的人物一致性（复用分镜同一套机制）：
 *  ① 身份口径复用 resolveShotCharacters（空声明 → scene.figures，不另写推断规则）；
 *  ② 有角色时挂三视图参考 + 同一套外貌锁定 + 反设定稿硬约束；
 *  ③ 走编辑端点（editVariant:"scene" 与 "shot" 共用同一实现），失败回退参考图生图；
 *  ④ 无角色时保持纯文本生图 + 构建期聚合告警；
 *  ⑤ 分镜/立绘/三视图/背景输出不变，imageOnly 不产出 CG。
 */
import { supportsImageEdits } from "../src/api/imageEdits";
import {
  buildCgPrompt,
  buildImageTasks,
  buildShotPrompt,
  cgCharacterIdsOf,
  CG_PROMPT_VERSION,
  fitImagePrompt,
  resolveShotCharacters,
  runImageTask,
  sceneEditPrompt,
  shotCharacterIdsOf,
  shotEditPrompt,
} from "../src/core/images";
import { setLogFileSink, type LogEntry } from "../src/utils/logger";
import { tauri } from "../src/utils/tauri";
import type { ApiConfig, ChapterScript, CharacterCard, ExtractionResult, ImageTask } from "../src/core/types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function card(id: string, imagePrompt: string): CharacterCard {
  return { id, name: id, appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt, color: "#fff" };
}

const alice = card("alice", "anime girl, silver long hair, red eyes, black school uniform with a red ribbon");
const bob = card("bob", "anime boy, short black hair, green eyes, blue coat");
const cards: ExtractionResult = { title: "t", characters: [alice, bob], scenes: [], items: [] };
const valid = new Set(["alice", "bob"]);

function cgScene(id: string, figures: string[], imagePrompt: string): ChapterScript["scenes"][number] {
  return {
    id,
    location: "城门",
    atmosphere: "黄昏",
    time: "傍晚",
    bgPrompt: "gate at dusk",
    itemEvents: [],
    figures,
    lines: [{ type: "dialogue", characterId: "alice", text: "…" }],
    cgEvent: { triggerIndex: 0, title: "决战", description: "决战", imagePrompt },
  } as ChapterScript["scenes"][number];
}

function chapterWithCg(scenes: ChapterScript["scenes"]): ChapterScript[] {
  return [{ chapter: 0, title: "第一章", scenes }];
}

function findCg(tasks: ImageTask[], id: string): ImageTask {
  const t = tasks.find((x) => x.kind === "cg" && x.id === id);
  assert(t, `应构建出 CG 任务：${id}`);
  return t!;
}

/* ---------- 1) CG 复用同一身份口径：空声明 → scene.figures ---------- */
{
  // 同一口径的直接证据：空声明输入落到 scene-figures 层
  const resolved = resolveShotCharacters({ characters: [] }, { figures: ["alice", "bob"] }, valid);
  assert(resolved.source === "scene-figures", `CG 空声明应命中 scene-figures：${resolved.source}`);
  assert(resolved.ids.join() === "alice,bob", `应按 scene.figures 顺序返回：${resolved.ids.join()}`);
  // 无效 id 过滤（与分镜同一规则）
  const filtered = resolveShotCharacters({ characters: [] }, { figures: ["alice", "ghost"] }, valid);
  assert(filtered.ids.join() === "alice", `无效 id 应过滤：${filtered.ids.join()}`);
  // figures 为空 → none（CG 保持纯文本生图，不开场景级推断）
  const none = resolveShotCharacters({ characters: [] }, { figures: [] }, valid);
  assert(none.source === "none" && none.ids.length === 0, "figures 为空时应为 none（不开场景级推断）");
  // 即使同场有分镜/说话人可推断，CG 也不吃第 3 层（默认关闭，与分镜默认口径一致）
  const withCandidates = resolveShotCharacters(
    { characters: [] },
    { figures: [], shots: [{ characters: ["alice"] }], lines: [{ type: "dialogue", characterId: "bob" }] },
    valid,
  );
  assert(withCandidates.source === "none", `CG 不应走场景级推断：${withCandidates.source}`);

  // 构建侧：CG 挂载与分镜同结构（主身份 + 追加身份 + 全量列表）
  const tasks = buildImageTasks(chapterWithCg([cgScene("s1", ["alice", "bob"], "final battle at the gate")]), cards, {
    styleAnchor: false,
  });
  const cg = findCg(tasks, "s1");
  assert(cg.characterId === "alice", `主身份取第一个：${String(cg.characterId)}`);
  assert(cg.refFromTask === "alice_threeview", `主身份参考三视图：${String(cg.refFromTask)}`);
  assert(
    Array.isArray((cg as { refFromTasks?: string[] }).refFromTasks)
      && (cg as { refFromTasks?: string[] }).refFromTasks!.join() === "bob_threeview",
    `其余角色作追加参考：${JSON.stringify((cg as { refFromTasks?: string[] }).refFromTasks)}`,
  );
  assert(cgCharacterIdsOf(cg).join() === "alice,bob", `全量出场角色应写入：${cgCharacterIdsOf(cg).join()}`);
  assert(cg.editVariant === "scene", `有角色 CG 应标记 editVariant=scene：${String(cg.editVariant)}`);
  assert(cg.promptVersion === CG_PROMPT_VERSION, `有角色 CG 应带 CG_PROMPT_VERSION：${String(cg.promptVersion)}`);

  // 单人 CG：只有主身份，无追加
  const solo = findCg(
    buildImageTasks(chapterWithCg([cgScene("s1", ["bob"], "bob alone")]), cards, { styleAnchor: false }),
    "s1",
  );
  assert(solo.characterId === "bob" && solo.refFromTask === "bob_threeview", "单人 CG 应挂主身份参考");
  assert(!(solo as { refFromTasks?: string[] }).refFromTasks, "单人不应有追加参考");
  assert(cgCharacterIdsOf(solo).join() === "bob", "单人全量列表应只有一个");
}

/* ---------- 2) CG 提示词含锁定与反设定稿（与分镜同一套） ---------- */
{
  // 同一套的直接证据：同输入下 CG 与分镜提示词逐字相同
  const a = buildCgPrompt("a battle at the gate", ", anime style", [alice, bob]);
  const b = buildShotPrompt("a battle at the gate", ", anime style", [alice, bob]);
  assert(a === b, "buildCgPrompt 与 buildShotPrompt 同输入应逐字相同（同一套实现）");

  const tasks = buildImageTasks(chapterWithCg([cgScene("s1", ["alice", "bob"], "a battle at the gate, character sheet layout")]), cards, {
    styleAnchor: false,
  });
  const cg = findCg(tasks, "s1");
  assert(cg.prompt.includes(alice.imagePrompt) && cg.prompt.includes(bob.imagePrompt), "CG 应重复每个出场角色的固定外貌");
  assert(cg.prompt.includes("character appearance lock"), "CG 应含外貌锁定段");
  assert(cg.prompt.includes("single scene illustration"), "CG 应含单幅插画硬约束");
  assert(cg.prompt.includes("not a character reference sheet"), "CG 应含反设定稿硬约束");
  assert(!cg.prompt.includes("character sheet layout"), "设定稿措辞应在拼接前剥掉");

  // 风格锚点提示保留：有锚点时画风段带锚点约束，且仍有锁定 + 硬约束
  const anchored = findCg(
    buildImageTasks(chapterWithCg([cgScene("s1", ["alice"], "a battle")]), cards, { styleAnchor: true }),
    "s1",
  );
  assert(anchored.prompt.includes("same exact art style"), "锚点开启时 CG 应保留风格锚定提示");
  assert(anchored.prompt.includes("character appearance lock"), "锚点开启时仍应有外貌锁定");
  assert(anchored.prompt.includes("single scene illustration"), "锚点开启时仍应有硬约束");

  // 超长压缩：CG 同样保住尾部两段（与分镜同口径）
  const filler = Array.from({ length: 80 }, (_, i) => `detail-${i} with ornate engraving and flowing cape`).join(", ");
  const longCg = buildCgPrompt(`a brave knight at the gate, ${filler}`, ", anime style", [alice]);
  assert(longCg.length > 1500, "夹具应超长");
  const fitted = fitImagePrompt(longCg, 1500);
  assert(fitted.length <= 1500, `压缩后应 ≤1500，实际 ${fitted.length}`);
  assert(fitted.includes("character appearance lock"), "压缩后必须保住外貌锁定段");
  assert(fitted.includes("single scene illustration"), "压缩后必须保住单幅插画硬约束");
}

/* ---------- 4) 无角色 CG 不挂参考且告警（构建期聚合，不逐张刷屏） ---------- */
function captureLogs(fn: () => void): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogFileSink((entry) => entries.push(entry));
  try {
    fn();
  } finally {
    setLogFileSink(null);
  }
  return entries;
}

{
  // 无角色 CG：无任何身份挂载、无 editVariant、无版本号、提示词为旧纯文本口径
  const tasks = buildImageTasks(chapterWithCg([cgScene("s1", [], "an empty valley at dawn")]), cards, {
    styleAnchor: false,
  });
  const cg = findCg(tasks, "s1");
  assert(!cg.characterId, "无角色 CG 不应挂主身份");
  assert(!cg.refFromTask, "无角色 CG 不应挂参考图");
  assert(!(cg as { refFromTasks?: string[] }).refFromTasks, "无角色 CG 不应有追加参考");
  assert(cgCharacterIdsOf(cg).length === 0, "无角色 CG 全量列表应为空");
  assert(!cg.editVariant, "无参考图就不该标 editVariant");
  assert(cg.promptVersion === undefined, "无角色 CG 提示词未变，不带版本号（缓存继续复用）");
  assert(!cg.prompt.includes("character appearance lock"), "无角色时不应有空的外貌锁定段");
  assert(!cg.prompt.includes("single scene illustration"), "无角色 CG 保持纯文本生图口径（无硬约束段）");
  assert(cg.prompt.startsWith("an empty valley at dawn"), "无角色 CG 提示词应沿用旧口径（剧情描述开头）");

  // 聚合告警：3 张无角色 CG 只报 1 条
  const many: ChapterScript[] = [
    {
      chapter: 0,
      title: "c",
      scenes: [
        cgScene("s1", [], "empty valley"),
        cgScene("s2", [], "empty street"),
        cgScene("s3", [], "empty classroom"),
      ],
    },
  ];
  const warns = captureLogs(() => buildImageTasks(many, cards, { styleAnchor: false }))
    .filter((e) => e.scope === "images" && e.level === "warn" && /CG/.test(e.message) && /纯文本生图/.test(e.message));
  assert(warns.length === 1, `3 张无角色 CG 应只聚合成 1 条告警，实际 ${warns.length}`);
  assert(/3 张 CG/.test(warns[0].message), `告警应报出张数：${warns[0].message}`);
  assert(/scene\.figures 为空/.test(warns[0].message), `告警应说明原因：${warns[0].message}`);

  // 有角色 CG 不触发该告警
  const noWarn = captureLogs(() =>
    buildImageTasks(chapterWithCg([cgScene("s1", ["alice"], "battle")]), cards, { styleAnchor: false }),
  ).filter((e) => e.scope === "images" && e.level === "warn" && /CG/.test(e.message) && /纯文本生图/.test(e.message));
  assert(noWarn.length === 0, "有角色 CG 不应报无角色告警");
}

/* ---------- 5) 三分镜/立绘输出不变 ---------- */
{
  // 立绘版三视图/立绘/背景不受 CG 改动影响：无场景约束段、无 editVariant、无版本号
  const tasks = buildImageTasks(chapterWithCg([cgScene("s1", ["alice"], "battle at the gate")]), cards, {
    styleAnchor: false,
    detail: "core",
  });
  for (const t of tasks) {
    if (t.kind === "cg") continue;
    assert(!t.prompt.includes("single scene illustration"), `${t.kind}:${t.id} 不应带场景硬约束`);
    assert(!t.prompt.includes("character appearance lock"), `${t.kind}:${t.id} 不应带外貌锁定段`);
  }
  const threeview = tasks.find((t) => t.kind === "threeview" && t.id === "alice_threeview")!;
  assert(threeview.prompt.includes("three-view character reference sheet"), "立绘版三视图仍是三视图设定稿（未改动）");
  assert(threeview.promptVersion === undefined, "立绘版三视图不带版本号（存量缓存照旧复用）");
  const bg = tasks.find((t) => t.kind === "background")!;
  assert(!("characterId" in bg) || !bg.characterId, "背景不应挂角色身份");
  assert(!bg.editVariant, "背景不应标 editVariant");
  assert(bg.promptVersion === undefined, "背景不带版本号");

  // imageOnly 行为逐字不变：不产出 CG
  const imageOnly = buildImageTasks(
    [
      {
        chapter: 0,
        title: "c",
        scenes: [
          {
            id: "s1",
            location: "城门",
            atmosphere: "黄昏",
            time: "傍晚",
            bgPrompt: "gate",
            itemEvents: [],
            figures: ["alice"],
            lines: [{ type: "dialogue", characterId: "alice", text: "…" }],
            shots: [{ id: "s1_shot1", prompt: "alice at the gate", triggerLineIndex: 0, characters: ["alice"] }],
            cgEvent: { triggerIndex: 0, title: "决战", description: "d", imagePrompt: "battle" },
          },
        ],
      },
    ],
    cards,
    { mode: "imageOnly", styleAnchor: false, threeView: true, actions: false, figureEmotions: false, detail: "core" },
  );
  assert(!imageOnly.some((t) => t.kind === "cg"), "imageOnly 不得产出 CG 任务");
  const shot = imageOnly.find((t) => t.kind === "shot")!;
  assert(shot.editVariant === "shot", "分镜仍走 editVariant=shot（未被 CG 的 scene 污染）");
  assert(shotCharacterIdsOf(shot).join() === "alice", "分镜身份口径不变");
}

/* ---------- 3) CG 走编辑可回退（与 shot 共用同一实现） ---------- */
{
  // 同一实现的直接证据：同任务下两种 edit 指令逐字相同
  const task: ImageTask = {
    kind: "cg",
    id: "s1",
    prompt: buildCgPrompt("a battle at the gate", ", anime style", [alice]),
    fileName: "cg_s1.png",
    width: 1536,
    height: 1024,
  };
  assert(sceneEditPrompt(task) === shotEditPrompt(task), "scene 与 shot 应共用同一编辑指令实现");
  assert(sceneEditPrompt(task).includes("identity reference"), "edit 指令应说明参考图只作身份基准");
  assert(/Do not redesign the character/i.test(sceneEditPrompt(task)), "edit 指令应禁止重新设计角色");
  assert(sceneEditPrompt(task).includes(task.prompt), "edit 指令应带上场景提示词本体");

  // 不支持编辑端点的线路自动回退参考图生图（分支条件）
  assert(supportsImageEdits("gpt-image-2"), "GPT-Image 系应支持编辑端点");
  assert(!supportsImageEdits("Qwen/Qwen-Image-Edit-2509"), "非 GPT-Image 线路应回退旧路径");
}

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-cg-consistency`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";

function gptConfig(): ApiConfig {
  // 中转线路（非官方域名）：模型族支持 /images/edits，同时 generations 也接受参考图——
  // 恰好覆盖「编辑失败回退参考图生图」的语义；官方域名 generations 会提前拒绝参考图，不适合测回退。
  return { id: "image", name: "Image", baseUrl: "https://relay.example.com/v1", apiKey: "test", model: "gpt-image-2" };
}

/** 编辑端点失败 → 回退参考图生图仍产出（与分镜同语义） */
async function testCgEditFailureFallsBackToReferenceGeneration(): Promise<void> {
  const cacheRoot = `${ROOT}/case-fallback/.novel2vn/cache`;
  await tauri.removePath(`${ROOT}/case-fallback`).catch(() => {});
  const refPath = `${ROOT}/case-fallback/threeview_alice.png`;
  await tauri.writeFileBase64(refPath, PNG_B64);
  const tasks = buildImageTasks(chapterWithCg([cgScene("s1", ["alice"], "battle at the gate")]), cards, {
    styleAnchor: false,
  });
  const cg = findCg(tasks, "s1");
  assert(cg.editVariant === "scene", "回退用例的 CG 应标记 scene");
  const messages: string[] = [];
  let calls = 0;
  const originalHttp = tauri.http;
  tauri.http = async (request) => {
    calls++;
    // 第一次是 /images/edits（参考图编辑）：模拟失败；之后是参考图生图：成功
    if (request.url.includes("/images/edits")) {
      throw new Error("edit endpoint boom");
    }
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  try {
    const path = await runImageTask(gptConfig(), cg, cacheRoot, (ev) => messages.push(ev.message), {
      force: true,
      outputDir: `${ROOT}/case-fallback`,
      figureBase: { alice_threeview: refPath },
    });
    assert(path !== null && (await tauri.pathExists(path)), "编辑失败回退后仍应产出图片");
    assert(calls >= 2, `应先调编辑端点再回退生图，实际调用 ${calls} 次`);
    assert(messages.some((m) => m.includes("改用参考图生图")), "回退时应明确提示改用参考图生图");
  } finally {
    tauri.http = originalHttp;
  }
}

async function main(): Promise<void> {
  await tauri.removePath(`${ROOT}/case-fallback`).catch(() => {});
  await testCgEditFailureFallsBackToReferenceGeneration();
  await tauri.removePath(`${ROOT}/case-fallback`).catch(() => {});
  console.log("=== cg consistency tests passed ===");
}

main().catch((error) => {
  console.error("cg consistency tests failed:", error);
  process.exit(1);
});
