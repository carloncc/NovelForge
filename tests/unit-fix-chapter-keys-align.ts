/**
 * 章节键对齐（Lead 收口补测）：把「磁盘形态」的剧本对齐到「产出键形态」。
 *
 * 背景：LLM 每章都输出 s1/s2…，跨章去重后第 2 章的 s1 实际是 s1_2；停用章还会让「位置」≠「novel index」。
 * 磁盘剧本缓存保持去重前/novel index 形态，而 assets.json 的配音与图片键是产出形态 ——
 * 不对齐就会：素材页点「重配」返回 null（按钮没反应）、看板把已存在的配音判成缺失（诱导重复付费）。
 */
import { dedupeSceneIdsAcrossChapters } from "../src/core/pipeline";
import {
  alignChaptersToKeys,
  writeChapterKeys,
  readChapterKeys,
  type ChapterKeysFile,
} from "../src/core/cache";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterScript } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 磁盘形态：每章都从 s1 开始（跨章重名），chapter 是 novel index */
function diskChapters(): ChapterScript[] {
  return [0, 1, 2].map((i) => ({
    chapter: i,
    title: `第${i + 1}章`,
    scenes: [
      { id: "s1", location: `loc${i}`, lines: [{ type: "narration", text: `a${i}` }] },
      { id: "s2", location: `loc${i}b`, lines: [{ type: "narration", text: `b${i}` }] },
    ],
  })) as unknown as ChapterScript[];
}

async function main(): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), "nf-chapter-keys-"));
  const disk = diskChapters();

  // 产出形态：与 pipeline 同口径跑一次跨章去重
  const produced = diskChapters();
  dedupeSceneIdsAcrossChapters(produced);

  const keys: ChapterKeysFile = {
    version: 1,
    novelFp: "fp",
    demo: false,
    posByIndex: { "0": 0, "1": 1, "2": 2 },
    sceneIdsByIndex: {
      "0": produced[0].scenes.map((s) => s.id),
      "1": produced[1].scenes.map((s) => s.id),
      "2": produced[2].scenes.map((s) => s.id),
    },
    vocalKeysByPos: {},
    at: new Date().toISOString(),
  };
  await writeChapterKeys(out, keys);
  const readBack = await readChapterKeys(out);
  assert(!!readBack, "chapter-keys.json 必须能读回");

  /* ① 磁盘形态 → 对齐到产出形态（scene.id 与 chapter 位置都换掉） */
  const aligned = alignChaptersToKeys(disk, readBack);
  assert(aligned !== disk, "需要改写时必须返回新数组（不得原地改入参）");
  aligned.forEach((c, i) => {
    assert(
      c.scenes.map((s) => s.id).join(",") === produced[i].scenes.map((s) => s.id).join(","),
      `第${i + 1}章 scene.id 未对齐：${c.scenes.map((s) => s.id).join(",")} vs ${produced[i].scenes.map((s) => s.id).join(",")}`,
    );
  });
  assert(produced[1].scenes[0].id === "s1_2", `前置条件：第 2 章的 s1 应去重成 s1_2，实际 ${produced[1].scenes[0].id}`);
  assert(disk[1].scenes[0].id === "s1", "入参不得被改写");

  /* ② 幂等：对齐后的形态再对齐一次必须原样返回（覆盖判据识别为「已对齐」） */
  const twice = alignChaptersToKeys(aligned, readBack);
  assert(twice === aligned, "已对齐的章节再次对齐必须原样返回（否则会二次映射到别章）");
  assert(
    twice[1].scenes.map((s) => s.id).join(",") === "s1_2,s2_2",
    `二次对齐不得改动 scene.id，实际 ${twice[1].scenes.map((s) => s.id).join(",")}`,
  );

  /* ③ 危险形态：有停用章时「位置」会出现缺口（posByIndex 覆盖不全）→ 整体放弃，不得错位 */
  const gapped: ChapterKeysFile = {
    ...keys,
    posByIndex: { "0": 0, "1": 1, "3": 2 }, // novel index 2 被停用
  };
  const alignedWithGap = alignChaptersToKeys(aligned, gapped);
  assert(alignedWithGap === aligned, "posByIndex 覆盖不全时必须整体放弃（宁可退化成旧行为也不错位）");

  /* ④ 没有映射（旧项目）→ 原样返回 */
  assert(alignChaptersToKeys(disk, null) === disk, "无映射时必须原样返回");

  console.log("=== 章节键对齐测试通过（磁盘→产出 / 幂等 / 缺口保护 / 无映射退化） ===");
}

main().catch((e) => {
  console.error("章节键对齐测试失败:", e);
  process.exit(1);
});
