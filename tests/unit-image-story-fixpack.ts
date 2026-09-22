/**
 * 图片小说修复包回归（#1099/#1101/#1103/#1111/#1132/#1133/#1134）：
 * 只覆盖纯函数（core/imageStory.ts + images.ts 分镜字段），不用 tauri/磁盘。
 */
import {
  buildImageStoryPlan,
  deriveImageStoryDir,
  estimateImageStoryPlan,
  normalizeShotTriggers,
  planChapterContinuity,
  resolveImageStoryDirOnLoad,
} from "../src/core/imageStory";
import { shotCharacterIdsOf } from "../src/core/images";
import type { ChapterScript, ExtractionResult, ImageStoryOptions } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function mkChapter(chapter: number, shots: number, trigger: number[] | null): ChapterScript {
  return {
    chapter,
    title: `第${chapter + 1}章`,
    scenes: [
      {
        id: `s${chapter}`,
        location: "城门",
        atmosphere: "黄昏",
        time: "傍晚",
        bgPrompt: "gate",
        itemEvents: [],
        figures: [],
        lines: [
          { type: "dialogue", characterId: "alice", text: "一" },
          { type: "dialogue", characterId: "bob", text: "二" },
          { type: "narration", text: "三" },
          { type: "dialogue", characterId: "alice", text: "四" },
          { type: "narration", text: "五" },
        ],
        shots: Array.from({ length: shots }, (_, i) => ({
          id: `s${chapter}_shot${i + 1}`,
          prompt: `shot ${i + 1}`,
          triggerLineIndex: trigger ? trigger[i] : i,
          characters: ["alice"],
          note: "",
        })),
      },
    ],
  };
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "alice", name: "爱丽丝", appearance: "金发", clothing: "白裙", personality: "活泼", voiceDesc: "", imagePrompt: "anime girl", color: "#fff" },
    { id: "bob", name: "鲍勃", appearance: "黑发", clothing: "外套", personality: "沉稳", voiceDesc: "", imagePrompt: "anime boy", color: "#000" },
  ],
  scenes: [],
  items: [{ id: "sword", name: "剑", appearance: "银剑", note: "信物", imagePrompt: "a silver sword" }],
};

const baseOpts: ImageStoryOptions = {
  shotsPerScene: 0,
  shotsPerChapter: 0,
  shotsTotal: 0,
  imageStyle: "anime style",
  imageSeed: 0,
  styleAnchor: false,
  includeItems: false,
};

// #1111：缺章必须检出（阻断组装），不能直接组装
{
  const plan = planChapterContinuity([mkChapter(0, 1, null), mkChapter(2, 1, null)], [0, 1, 2]);
  assert(!plan.ok, "#1111 缺第 2 章时 ok 应为 false");
  assert(plan.missing.join(",") === "1", `#1111 缺失章应为 [1]，实际 [${plan.missing}]`);
}

// #1132：停用中间章（启用 [0,2] 且剧本齐备）→ 通过并重编号为连续 0..n-1
{
  const plan = planChapterContinuity([mkChapter(2, 1, null), mkChapter(0, 1, null)], [0, 2]);
  assert(plan.ok, "#1132 启用章齐备时应通过");
  assert(plan.renumbered.map((c) => c.chapter).join(",") === "0,1", "#1132 应重编号为 0,1");
  assert(plan.renumbered[0].title === "第1章" && plan.renumbered[1].title === "第3章", "#1132 重编号只改 chapter，不改内容顺序");
}

// #1134：缺失/重复/非递增 → 均匀铺开；合法的不动；单张不动
{
  const dup = mkChapter(0, 3, [0, 0, 0]);
  const { chapters, repairs } = normalizeShotTriggers([dup]);
  const after = chapters[0].scenes[0].shots!.map((s) => s.triggerLineIndex);
  assert(repairs.length === 1, "#1134 重复触发应记一条 repair");
  assert(after.join(",") === "1,2,3", `#1134 应铺开为 1,2,3，实际 ${after}`);
  const ok = mkChapter(0, 2, [0, 3]);
  const r2 = normalizeShotTriggers([ok]);
  assert(r2.repairs.length === 0, "#1134 合法触发不应 repair");
  const single = mkChapter(0, 1, [0]);
  assert(normalizeShotTriggers([single]).repairs.length === 0, "#1134 单张分镜不动");
}

// #1101：换项目不残留——自动跟随的重算，手动的不动
{
  const d = deriveImageStoryDir("D:/books/A", "B");
  assert(d === "D:/books/B-图片版", `#1101 推导异常：${d}`);
  const first = resolveImageStoryDirOnLoad({ rememberedDir: "", rememberedAuto: true, derivedDir: "D:/books/B-图片版" });
  assert(first.dir === "D:/books/B-图片版" && first.auto, "#1101 首次使用应取推导目录");
  const manual = resolveImageStoryDirOnLoad({ rememberedDir: "D:/old/A-图片版", rememberedAuto: false, derivedDir: "D:/books/B-图片版" });
  assert(manual.dir === "D:/old/A-图片版" && !manual.followed, "#1101 手动目录应保留不动");
  const auto = resolveImageStoryDirOnLoad({ rememberedDir: "D:/books/A-图片版", rememberedAuto: true, derivedDir: "D:/books/B-图片版" });
  assert(auto.dir === "D:/books/B-图片版" && auto.followed, "#1101 自动目录换作品应跟随重算");
}

// #1103：不限张数时必须标 unbounded（页面按此显示「粗估」而非「最多」）
{
  const est = estimateImageStoryPlan(10, { ...baseOpts }, 5);
  assert(est.unbounded, "#1103 三旋钮全 0 时应标 unbounded");
  assert(est.total === 10 * 4 * 2 + 5, `#1103 粗估应按每场景 2 张（无锚点），实际 ${est.total}`);
  const limited = estimateImageStoryPlan(10, { ...baseOpts, shotsTotal: 10 }, 5);
  assert(!limited.unbounded && limited.total === 10 + 5, "#1103 设上限后不再是 unbounded");
}

// #1133：多人分镜全量角色进任务（主身份 + 追加参考 + 守卫用全量 id）
{
  const ch: ChapterScript[] = [
    {
      chapter: 0,
      title: "第一章",
      scenes: [
        {
          id: "s1",
          location: "城门",
          atmosphere: "黄昏",
          time: "傍晚",
          bgPrompt: "gate",
          itemEvents: [],
          figures: [],
          lines: [{ type: "dialogue", characterId: "alice", text: "一" }],
          shots: [{ id: "s1_shot1", prompt: "two people", triggerLineIndex: 0, characters: ["alice", "bob"], note: "" }],
        },
      ],
    },
  ];
  const plan = buildImageStoryPlan(ch, cards, baseOpts);
  const shot = plan.tasks.find((t) => t.kind === "shot")!;
  assert(shot.refFromTask === "alice_threeview", "#1133 主身份应为第一个角色");
  assert(
    JSON.stringify((shot as unknown as { refFromTasks: string[] }).refFromTasks) === JSON.stringify(["bob_threeview"]),
    "#1133 其余角色应进 refFromTasks",
  );
  assert(shotCharacterIdsOf(shot).join(",") === "alice,bob", "#1133 守卫应看到全部出场角色");
  assert(shotCharacterIdsOf({ kind: "shot", id: "x", prompt: "p", fileName: "f.png", width: 1, height: 1, characterId: "alice" } as never).join(",") === "alice", "#1133 旧单角色字段兼容");
}

// #1099：图片小说模式不构建物品任务（渲染/鉴赏都不展示，生成即浪费）——开关开启也应为 0
{
  const plan = buildImageStoryPlan([mkChapter(0, 1, null)], cards, { ...baseOpts, includeItems: true });
  assert(plan.itemCount === 0, `#1099 imageOnly 下物品任务应为 0，实际 ${plan.itemCount}`);
  assert(!plan.tasks.some((t) => t.kind === "item"), "#1099 任务列表不得含 item");
}

console.log("=== image story fixpack tests passed ===");
