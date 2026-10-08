/**
 * #1518：stageCascade.statusImageTasks 的选项映射必须真正接线到 buildImageTasks。
 *
 * 背景：useStageStatus（看板绿灯）与 stageCascade（级联/费用确认）都要把
 * GenerationOptions 翻译成 buildImageTasks 的入参。此前是两份**逐字相同**的副本，
 * 而 stageCascade.ts 的注释明写「两处必须一致，否则看板绿灯与级联计数会打架」——
 * 却没有任何东西保证它们继续一样。现已改为共用同一封装（见 useStageStatus.ts）。
 *
 * 本测试防的是另一种漂移：封装里的映射被改坏/漏传某个选项（少写一行
 * `styleAnchor: …` 之类），导致级联低估或高估要花的钱，而看板毫无察觉。
 */
import type { ChapterScript, CharacterCard, ExtractionResult, GenerationOptions } from "../src/core/types";
import { statusImageTasks } from "../src/core/stageCascade";
import { buildImageTasks } from "../src/core/images";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const alice: CharacterCard = {
  id: "alice",
  name: "爱丽丝",
  appearance: "银发少女",
  clothing: "校服",
  personality: "开朗",
  voiceDesc: "少女音",
  voiceName: "female-shaonv",
  imagePrompt: "alice, silver hair, school uniform",
  color: "#9ca3af",
  // 自定义表情集：让 figureDetail 变得可观测——core 档一律用标准 5 表情，
  // full 档优先用本集合（images.ts:760）。没有它，detail 在夹具里是惰性的。
  emotions: ["开心", "愤怒"],
};

const cards: ExtractionResult = { title: "测试", characters: [alice], scenes: [], items: [] };

const chapters: ChapterScript[] = [
  {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "scene_1",
        location: "教室",
        atmosphere: "日常",
        time: "白天",
        bgPrompt: "classroom, daylight",
        // #1518：CG 任务以 scene.cgEvent 为门槛，夹具必须带它才能验证 cgPerChapter 是否透传
        cgEvent: { triggerIndex: 0, title: "相遇", description: "雨中的相遇", imagePrompt: "two students under a tree in the rain" },
        itemEvents: [],
        figures: ["alice"],
        lines: [
          { type: "dialogue", characterId: "alice", text: "早上好。" },
          { type: "narration", text: "窗外下着雨。" },
        ],
      },
      {
        id: "scene_2",
        location: "走廊",
        atmosphere: "紧张",
        time: "傍晚",
        bgPrompt: "corridor, dusk",
        cgEvent: { triggerIndex: 0, title: "追逐", description: "走廊追逐", imagePrompt: "a chase down a corridor" },
        itemEvents: [],
        figures: ["alice"],
        lines: [{ type: "narration", text: "脚步声逼近。" }],
      },
    ],
  },
];

const BASE: GenerationOptions = {
  useImage: true,
  useTts: true,
  useVideoPoints: false,
  useBgm: false,
  figureEmotions: false,
  figureDetail: "core",
  figureActions: false,
  characterPoses: false,
  imageSelfCheck: false,
  imageBudgetPerChapter: 0,
  cgPerChapter: 0,
  skipCache: false,
  videoPointsPerChapter: 0,
  characterIntroCard: false,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: false,
  scriptStyle: "",
  language: "",
};

const opts = (over: Partial<GenerationOptions>): GenerationOptions => ({ ...BASE, ...over });
const kinds = (o: GenerationOptions): string[] => statusImageTasks(chapters, cards, o).map((t) => t.kind).sort();

function main(): void {
  // 1) 封装必须与「显式映射后直接调 buildImageTasks」逐条等价（锁住封装本身）
  for (const variant of [BASE, opts({ styleAnchor: true }), opts({ characterPoses: true }), opts({ cgPerChapter: 2 })]) {
    const viaWrapper = statusImageTasks(chapters, cards, variant);
    const viaDirect = buildImageTasks(chapters, cards, {
      cgPerChapter: variant.cgPerChapter ?? 0,
      maxPerChapter: variant.imageBudgetPerChapter ?? 0,
      figureEmotions: variant.figureEmotions,
      detail: variant.figureDetail ?? "full",
      style: variant.imageStyle,
      threeView: variant.characterPoses !== false,
      actions: variant.characterPoses !== false,
      styleAnchor: variant.styleAnchor !== false,
    });
    assert(
      JSON.stringify(viaWrapper) === JSON.stringify(viaDirect),
      "statusImageTasks 必须与 buildImageTasks 的显式映射逐条等价",
    );
  }

  // 2) 每个映射到的选项都必须真的影响结果（漏传任何一项都会在这里露馅）
  assert(kinds(opts({ styleAnchor: true })).includes("anchor"), "styleAnchor=true 应产生 anchor 任务");
  assert(!kinds(opts({ styleAnchor: false })).includes("anchor"), "styleAnchor=false 不应产生 anchor 任务");

  const poses = kinds(opts({ characterPoses: true }));
  const noPoses = kinds(opts({ characterPoses: false }));
  assert(JSON.stringify(poses) !== JSON.stringify(noPoses), "characterPoses 必须透传到 threeView/actions");

  // 注意语义：cgPerChapter=0 表示「不限制」（types.ts 明写），不是「不要 CG」——
  // 所以封面上限的验证必须用 cgPerChapter=1 对比不限，否则测的是错的东西。
  const cgUnlimited = kinds(opts({ cgPerChapter: 0 })).filter((k) => k === "cg").length;
  assert(cgUnlimited === 2, `cgPerChapter=0 为不限，两个 cgEvent 都应出任务，实际 ${cgUnlimited}`);
  const cgCapped = kinds(opts({ cgPerChapter: 1 })).filter((k) => k === "cg").length;
  assert(cgCapped === 1, `cgPerChapter=1 应只出 1 个 cg 任务，实际 ${cgCapped}（上限未透传）`);

  const emotions = statusImageTasks(chapters, cards, opts({ figureEmotions: true })).length;
  const plain = statusImageTasks(chapters, cards, opts({ figureEmotions: false })).length;
  assert(emotions > plain, "figureEmotions 必须透传（表情差分应增加任务）");

  // figureDetail 只在 figureEmotions 打开（表情集口径）或 threeView 打开（服装差分）时可观测，
  // 两者都关时它是惰性的——这不是 bug，是 buildImageTasks 的既定分支。
  const emoCore = statusImageTasks(chapters, cards, opts({ figureEmotions: true, figureDetail: "core" })).length;
  const emoFull = statusImageTasks(chapters, cards, opts({ figureEmotions: true, figureDetail: "full" })).length;
  assert(emoCore !== emoFull, `figureDetail 必须透传（core=${emoCore} / full=${emoFull} 应不同）`);

  // 预算口径：maxPerChapter 只收「背景」——buildImageTasks 里背景循环用 count 收口，
  // CG 是紧随其后的**另一个**循环、由 cgPerChapter 独立收口（images.ts:926-944）。
  // 因此这里断言背景张数，而不是「总任务数」——后者含立绘/三视图，永远不会等于预算值。
  const bgOf = (o: GenerationOptions): number =>
    statusImageTasks(chapters, cards, o).filter((t) => t.kind === "background").length;
  assert(bgOf(opts({ imageBudgetPerChapter: 0 })) === 2, "预算 0 为不限，两个场景各一张背景");
  assert(bgOf(opts({ imageBudgetPerChapter: 1 })) === 1, "imageBudgetPerChapter=1 应把背景收到 1 张");

  console.log("=== 图像任务选项映射测试通过（#1518）===");
}

main();
