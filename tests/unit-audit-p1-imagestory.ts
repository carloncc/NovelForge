/**
 * ReqFlow P1 图片小说专项回归（batch-p1.json）：
 * 只覆盖纯函数（core/imageStory.ts + core/cache.ts + configMigration），不用 tauri/磁盘/Vue。
 * - #1325/#1371：粗估按 shotsTotal 封顶；
 * - #1340：imageOnly 下风格锚点不生成不计费（plan 无 anchor、粗估不含锚点）；
 * - #1341：剧本指纹带 cardsFp（卡片 id 变化即失效）；
 * - #1342：图像并发取配置并封顶 8；
 * - #1351：停用章重编号连续（planChapterContinuity）。
 */
import {
  buildImageStoryPlan,
  estimateImageStoryPlan,
  planChapterContinuity,
} from "../src/core/imageStory";
import { cardsFingerprint, scriptFingerprint } from "../src/core/cache";
import { concurrencyFor } from "../src/stores/configMigration";
import type { ChapterScript, ExtractionResult, ImageStoryOptions } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "alice", name: "爱丽丝", appearance: "金发", clothing: "白裙", personality: "活泼", voiceDesc: "", imagePrompt: "anime girl", color: "#fff" },
  ],
  scenes: [],
  items: [],
};

function mkChapter(chapter: number): ChapterScript {
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
        lines: [{ type: "narration", text: "一" }],
        shots: [{ id: `s${chapter}_shot1`, prompt: "a gate", triggerLineIndex: 0, characters: ["alice"], note: "" }],
      },
    ],
  };
}

const base: ImageStoryOptions = {
  shotsPerScene: 0,
  shotsPerChapter: 0,
  shotsTotal: 0,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: false,
  includeItems: false,
};

// #1325/#1371：无剧本粗估按 shotsTotal 封顶（10 章 × 4 场景 × 2 张 = 80，设上限 50 → 50 + 角色数）
{
  const est = estimateImageStoryPlan(10, { ...base, shotsTotal: 50 }, 2);
  assert(est.total === 52, `#1325 粗估应按上限封顶为 52，实际 ${est.total}`);
  assert(!est.exact, "#1371 粗估 exact 应为 false（页面据此显示“粗估”而非“最多”）");
  const unbounded = estimateImageStoryPlan(10, { ...base }, 2);
  assert(unbounded.unbounded, "#1371 三旋钮全 0 时应标 unbounded");
  assert(unbounded.total === 82, `#1371 无上限粗估应为 82，实际 ${unbounded.total}`);
}

// #1340：styleAnchor 开启在 imageOnly 下也不生成锚点、不计费
{
  const plan = buildImageStoryPlan([mkChapter(0)], cards, { ...base, styleAnchor: true });
  assert(!plan.tasks.some((t) => t.kind === "anchor"), "#1340 imageOnly 下不得有 anchor 任务");
  const est = estimateImageStoryPlan(10, { ...base, styleAnchor: true }, 2);
  assert(est.total === 82, `#1340 粗估不得含锚点（应为 82），实际 ${est.total}`);
  assert(Math.abs(plan.estimatedYuan - Math.round(plan.tasks.length * 0.3 * 100) / 100) < 1e-9, "#1340 费用仍按任务数 × 单价");
}

// #1341：卡片 id 变化 → cardsFp 变化 → scriptFingerprint 变化（旧剧本缓存失效）；同卡片指纹稳定
{
  const fp1 = cardsFingerprint(cards);
  const changed: ExtractionResult = {
    ...cards,
    characters: [{ ...cards.characters[0], id: "alice2" }],
  };
  const fp2 = cardsFingerprint(changed);
  assert(fp1 !== fp2, "#1341 角色 id 变化时 cardsFp 必须变化");
  const s1 = scriptFingerprint({ style: "", compressNarration: false, visualMode: "imageOnly", cardsFp: fp1 });
  const s2 = scriptFingerprint({ style: "", compressNarration: false, visualMode: "imageOnly", cardsFp: fp2 });
  assert(s1 !== s2, "#1341 cardsFp 不同时剧本指纹必须不同（旧剧本失效）");
  const s3 = scriptFingerprint({ style: "", compressNarration: false, visualMode: "imageOnly", cardsFp: fp1 });
  assert(s1 === s3, "#1341 同一卡片指纹应稳定");
}

// #1342：并发公式 Math.min(8, concurrencyFor(cfg, "image"))——默认 3，配置 30 封顶 8，配置 1 生效 1
{
  assert(concurrencyFor(undefined, "image") === 3, "#1342 默认并发应为 3");
  const cap = (n: number): number => Math.min(8, concurrencyFor({ concurrency: n } as never, "image"));
  assert(cap(30) === 8, "#1342 配置 30 应封顶 8");
  assert(cap(1) === 1, "#1342 配置 1 应生效 1（限流用户可降并发）");
}

// #1351：启用 [0,2] 且剧本齐备 → ok 并重编号 0,1；缺章 → ok=false
{
  const ok = planChapterContinuity([mkChapter(2), mkChapter(0)], [0, 2]);
  assert(ok.ok && ok.renumbered.map((c) => c.chapter).join(",") === "0,1", "#1351 应重编号为 0,1");
  const missing = planChapterContinuity([mkChapter(0), mkChapter(2)], [0, 1, 2]);
  assert(!missing.ok && missing.missing.join(",") === "1", "#1351 缺章应检出 [1]");
}

console.log("=== audit p1 image story tests passed ===");
