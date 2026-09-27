/**
 * 空 characters 分镜的兜底身份（分层 + 确定性）与"推断不出时必须显式告警"。
 *
 * 背景（实测数据，非推断）：线上项目 4256-图片版 4 章 / 219 张分镜里 characters 为空的 17 张，
 * 逐张核过提示词后确认 12 张是真正的无人物空镜（赛马场全景 / 古民宅外景 / 游乐园全景 /
 * 火箭发射 / 作者后记书桌，其中 5 张提示词里直接写了 "no characters"），模型留空是对的。
 * 因此"场景级推断"（同场其它分镜声明的角色 + 场景台词说话人）不能默认开启——默认开启等于把
 * 主角的脸硬塞进空镜。这里锁死三件事：
 *   ① 分层口径与确定性：声明 > scene.figures > （可选）场景级推断 > 留空；
 *   ② 默认（未开开关）不做场景级推断，任务不带任何身份参考；
 *   ③ 无论推断成功还是彻底查不到，构建期都必须有聚合告警（不逐张刷屏）。
 */
import { buildImageTasks, resolveShotCharacters, shotCharacterIdsOfTask } from "../src/core/images";
import { setLogFileSink, type LogEntry } from "../src/utils/logger";
import type { ChapterScript, CharacterCard, ExtractionResult, ImageTask } from "../src/core/types";

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

/* ---------- 1) 分层口径：声明优先 ---------- */
{
  const declared = resolveShotCharacters({ characters: ["alice", "nobody"] }, { figures: ["bob"] }, valid);
  assert(declared.source === "declared", `声明应命中 declared：${declared.source}`);
  assert(declared.ids.join() === "alice", `声明应过滤无效 id：${declared.ids.join()}`);

  const fromFigures = resolveShotCharacters({}, { figures: ["bob", "nobody"] }, valid);
  assert(fromFigures.source === "scene-figures", `漏标应命中 scene-figures：${fromFigures.source}`);
  assert(fromFigures.ids.join() === "bob", `场景出场表应过滤无效 id：${fromFigures.ids.join()}`);

  const none = resolveShotCharacters({}, {}, valid);
  assert(none.source === "none" && none.ids.length === 0, "三处都没有才是 none");

  // 旧签名保持两层兜底语义不变（既有调用方/单测的兼容面）
  assert(shotCharacterIdsOfTask({}, { figures: ["bob", "nobody"] }, valid).join() === "bob", "旧签名仍退回场景出场表");
  assert(shotCharacterIdsOfTask({}, { figures: [] }, valid).length === 0, "旧签名不做场景级推断");
  // 声明里全是无效 id 时不算"声明过"，要继续往下兜底
  assert(resolveShotCharacters({ characters: ["ghost"] }, { figures: ["bob"] }, valid).source === "scene-figures", "无效声明不算声明");
}

/* ---------- 2) 场景级推断：默认关闭，显式开启才生效 ---------- */
{
  const scene = {
    figures: [] as string[],
    shots: [{ characters: ["bob"] }, { characters: [] }, { characters: ["alice", "bob"] }],
    lines: [
      { type: "dialogue" as const, characterId: "alice" },
      { type: "narration" as const },
    ],
    choices: [{ lines: [{ type: "dialogue" as const, characterId: "bob" }] }],
  };
  const off = resolveShotCharacters({}, scene, valid);
  assert(off.source === "none", `默认必须不做场景级推断：${off.source}`);

  const on = resolveShotCharacters({}, scene, valid, { allowSceneInference: true });
  assert(on.source === "scene-inferred", `开启后应命中 scene-inferred：${on.source}`);
  // 顺序：同场其它分镜声明序（bob, alice）＋ 说话人（alice, bob 去重）→ bob,alice
  assert(on.ids.join() === "bob,alice", `候选集应去重保序：${on.ids.join()}`);
  // 分镜表顺序（场景表在前）时 figures 仍优先于场景级推断
  assert(
    resolveShotCharacters({}, { ...scene, figures: ["alice"] }, valid, { allowSceneInference: true }).source === "scene-figures",
    "scene.figures 优先于场景级推断",
  );
  // 只有说话人可依据时也能推出来（含分支台词）
  const speakersOnly = resolveShotCharacters(
    {},
    { figures: [], lines: [{ type: "dialogue", characterId: "alice" }], choices: [{ lines: [{ type: "dialogue", characterId: "bob" }] }] },
    valid,
    { allowSceneInference: true },
  );
  assert(speakersOnly.source === "scene-inferred" && speakersOnly.ids.join() === "alice,bob", `说话人应可作候选：${speakersOnly.ids.join()}`);
  // narrator / 无效 id 不得进候选
  const dirty = resolveShotCharacters(
    {},
    { figures: [], lines: [{ type: "dialogue", characterId: "narrator" }, { type: "dialogue", characterId: "nobody" }] },
    valid,
    { allowSceneInference: true },
  );
  assert(dirty.source === "none", `narrator/无效 id 不算角色：${dirty.source}`);
}

/* ---------- 3) 确定性：同输入必得同输出，且与询问顺序无关 ---------- */
{
  const scene = {
    figures: [] as string[],
    shots: [{ characters: ["bob"] }, { characters: ["alice"] }, {}],
    lines: [{ type: "dialogue" as const, characterId: "alice" }],
  };
  const a = resolveShotCharacters(scene.shots[2], scene, valid, { allowSceneInference: true });
  const b = resolveShotCharacters({}, scene, valid, { allowSceneInference: true });
  const c = resolveShotCharacters({}, scene, valid, { allowSceneInference: true });
  assert(a.ids.join() === b.ids.join() && b.ids.join() === c.ids.join(), "重复调用必须同结果");
  assert(a.ids.join() === "bob,alice", `候选集与被问的分镜无关：${a.ids.join()}`);
}

/* ---------- 4) buildImageTasks：默认不给空镜挂参考图 ---------- */
function sceneOf(id: string, figures: string[], shots: { prompt: string; characters?: string[] }[]): ChapterScript["scenes"][number] {
  return {
    id,
    location: "城门",
    atmosphere: "黄昏",
    time: "傍晚",
    bgPrompt: "gate",
    itemEvents: [],
    figures,
    lines: [{ type: "dialogue", characterId: "alice", text: "…" }],
    shots: shots.map((s, i) => ({
      id: `${id}_shot${i + 1}`,
      prompt: s.prompt,
      triggerLineIndex: i,
      ...(s.characters ? { characters: s.characters } : {}),
    })),
  };
}

const mixed: ChapterScript[] = [
  {
    chapter: 0,
    title: "c",
    scenes: [
      sceneOf("s1", [], [
        { prompt: "a girl at the gate", characters: ["alice"] },
        { prompt: "an empty street at dawn" },
      ]),
    ],
  },
];
const opts = { mode: "imageOnly" as const, styleAnchor: false, threeView: true, actions: false, figureEmotions: false, detail: "core" as const };

function findShot(tasks: ImageTask[], index: number): ImageTask {
  return tasks.find((t) => t.kind === "shot" && t.shotIndex === index)!;
}

{
  const tasks = buildImageTasks(mixed, cards, opts);
  const empty = findShot(tasks, 1);
  assert(!empty.characterId, "默认口径下空镜不得凭空挂身份");
  assert(!empty.refFromTask, "默认口径下空镜不得凭空挂参考图");
  assert(!("shotCharacterIds" in empty) || !(empty as { shotCharacterIds?: string[] }).shotCharacterIds, "默认口径下空镜不得写出场角色");
  assert(!empty.editVariant, "没有参考图就不该标 editVariant");
  const declared = findShot(tasks, 0);
  assert(declared.characterId === "alice" && declared.refFromTask === "alice_threeview", "已声明的分镜不受影响");
  assert(tasks.some((t) => t.kind === "threeview" && t.id === "alice_threeview"), "基准图只给有分镜的角色");
  assert(!tasks.some((t) => t.kind === "threeview" && t.id === "bob_threeview"), "只在别的分镜出现的角色不建基准图");
}

/* ---------- 5) 显式开启兜底：空镜拿到参考图 + 外貌锁定 + 基准图 ---------- */
{
  const tasks = buildImageTasks(mixed, cards, { ...opts, shotCharacterFallback: "scene" });
  const empty = findShot(tasks, 1);
  assert(empty.characterId === "alice", `兜底后主身份应取第一个候选：${String(empty.characterId)}`);
  assert(empty.refFromTask === "alice_threeview", "兜底后应挂基准图参考");
  assert((empty as { shotCharacterIds?: string[] }).shotCharacterIds?.join() === "alice", "兜底后应写出全部出场角色");
  assert(empty.editVariant === "shot", "兜底后有参考图，应走 edit");
  assert(empty.prompt.includes(alice.imagePrompt), "兜底后应重复角色固定外貌");
  // 剧本数据本身不得被改写（兜底只作用于参考图/外貌锁定）
  assert(mixed[0].scenes[0].shots![1].characters === undefined, "兜底不得写回 shot.characters");
}

/* ---------- 6) 构建期聚合告警：推断不出时必须显式提示，且不逐张刷屏 ---------- */
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
  const many: ChapterScript[] = [
    {
      chapter: 0,
      title: "c",
      scenes: [sceneOf("s1", [], [
        { prompt: "an empty street at dawn" },
        { prompt: "a quiet river at dusk" },
        { prompt: "an empty classroom" },
      ])],
    },
  ];
  const warns = captureLogs(() => buildImageTasks(many, cards, opts))
    .filter((e) => e.scope === "images" && e.level === "warn" && /纯文本生图/.test(e.message));
  assert(warns.length === 1, `3 张查不到角色的分镜应只聚合成 1 条告警，实际 ${warns.length}`);
  assert(/3 张分镜未声明角色/.test(warns[0].message), `告警应报出张数：${warns[0].message}`);
  assert(/无法推断/.test(warns[0].message) && /人物一致性无法保证/.test(warns[0].message), `告警应说明后果：${warns[0].message}`);
  assert(/shotCharacterFallback/.test(warns[0].message), `默认关闭时应提示可开启兜底开关：${warns[0].message}`);
}

{
  // 开启兜底后：能推出来的那批单独告警，推不出来的仍必须告警
  const half: ChapterScript[] = [
    {
      chapter: 0,
      title: "c",
      scenes: [
        sceneOf("s1", [], [{ prompt: "a girl at the gate", characters: ["alice"] }, { prompt: "an empty street at dawn" }]),
        // 整个场景没有任何可依据的角色（说话人 alice 不在角色卡集合里）
        {
          id: "s2",
          location: "空街",
          atmosphere: "冷",
          time: "夜",
          bgPrompt: "street",
          itemEvents: [],
          figures: [],
          lines: [{ type: "dialogue", characterId: "stranger", text: "…" }],
          shots: [{ id: "s2_shot1", prompt: "an empty street at dawn", triggerLineIndex: 0 }],
        },
      ],
    },
  ];
  const entries = captureLogs(() => buildImageTasks(half, cards, { ...opts, shotCharacterFallback: "scene" }))
    .filter((e) => e.scope === "images" && e.level === "warn");
  const inferred = entries.filter((e) => /场景出场角色兜底/.test(e.message));
  const degraded = entries.filter((e) => /纯文本生图/.test(e.message));
  assert(inferred.length === 1, `兜底成功应聚合告警 1 条，实际 ${inferred.length}`);
  assert(/1 张分镜未声明 characters/.test(inferred[0].message), `兜底告警应报出张数：${inferred[0].message}`);
  assert(degraded.length === 1 && /1 张分镜未声明角色/.test(degraded[0].message), `仍推不出来的必须继续告警：${degraded.map((e) => e.message).join(" | ")}`);
  assert(!/shotCharacterFallback/.test(degraded[0].message), "已开启兜底时不应再提示开启开关");
}

console.log("=== shot character fallback tests passed ===");
