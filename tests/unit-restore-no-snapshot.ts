/**
 * #1509 回归：把「开发到一半的项目」整目录交给应用（「加载该项目」/ 导入项目）后，
 * 必须能继续生成未完成的部分。
 *
 * 旧实现的问题：\`restoreProjectState\` 在缺少 \`.novel2vn/project_state.json\` 时**直接返回空状态**。
 * 而那个文件只是「上次保存时的快照」——用户把项目目录拷到另一台机器、只带了 .novel2vn 与产物、
 * 或快照因任何原因缺失时，磁盘上其实还有 split.json（分章正文）、cards.json（卡片）、
 * cache/（剧本缓存），完全够继续生成。旧行为下 novel/cards 全丢，生成页只剩「还没有小说」，
 * 用户无法继续未完成的部分。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { restoreProjectState } from "../src/utils/persist";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-restore-no-snapshot`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface SeedOptions {
  split: boolean;
  scriptCache: boolean;
  cards: boolean;
  state: boolean;
}

function seed(outputDir: string, opts: SeedOptions): void {
  mkdirSync(`${outputDir}/.novel2vn/cache`, { recursive: true });
  writeFileSync(`${outputDir}/.novel2vn/meta.json`, JSON.stringify({
    title: "半成品", gameKey: "key12345", chapterCount: 2, charCount: 12, sceneCount: 2,
    lineCount: 4, outputDir, webgalVersion: "4.6.3", generatedAt: "2026-01-01",
  }), "utf8");
  if (opts.split) {
    writeFileSync(`${outputDir}/.novel2vn/split.json`, JSON.stringify({
      fp: "fp-test", method: "ai",
      chapters: [
        { index: 0, title: "第一章", text: "第一章正文。", charCount: 6 },
        { index: 1, title: "第二章", text: "第二章正文。", charCount: 6 },
      ],
    }), "utf8");
  }
  if (opts.scriptCache) {
    writeFileSync(`${outputDir}/.novel2vn/cache/script_ch1_aaaa.json`, JSON.stringify({ chapter: 0, title: "第一章", scenes: [] }), "utf8");
    writeFileSync(`${outputDir}/.novel2vn/cache/script_ch2_bbbb.json`, JSON.stringify({ chapter: 1, title: "第二章", scenes: [] }), "utf8");
  }
  if (opts.cards) {
    writeFileSync(`${outputDir}/.novel2vn/cards.json`, JSON.stringify({
      title: "半成品",
      characters: [{ id: "linche", name: "林澈", appearance: "a", clothing: "c", personality: "p", voiceDesc: "v", imagePrompt: "i", color: "#fff" }],
      scenes: [], items: [],
    }), "utf8");
  }
  if (opts.state) {
    writeFileSync(`${outputDir}/.novel2vn/project_state.json`, JSON.stringify({
      materials: [], outputDir, options: { useImage: true },
      novel: {
        sourcePath: `${outputDir}/gone.txt`, fileName: "gone.txt", encoding: "utf-8",
        chapters: [{ index: 0, title: "第一章" }, { index: 1, title: "第二章" }],
      },
    }), "utf8");
  }
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });

  // 1) 无 project_state，但有 split.json + cards.json → 小说与卡片都要恢复
  {
    const dir = `${ROOT}/split-and-cards`;
    seed(dir, { split: true, scriptCache: true, cards: true, state: false });
    const r = await restoreProjectState(dir);
    assert(r.novel, "缺少状态快照时仍必须用 split.json 重建小说（否则无法继续逐章生成）");
    assert(r.novel.chapters.length === 2, `应恢复 2 章，实际 ${r.novel.chapters.length}`);
    assert(r.novel.chapters[0].text === "第一章正文。", "章节正文应来自分章缓存");
    assert(!r.loadError, `不应报加载错误：${r.loadError}`);
    // lastResult 的组装属于上层 store（restoreProject 会用磁盘 cards.json + meta.json 兜底），
    // 这里只断言本层不误报；端到端由 stores 层的用例覆盖。
    assert(
      r.warnings.some((w) => w.includes("缺少项目状态快照")),
      `应明确告知按磁盘重建，实际 ${JSON.stringify(r.warnings)}`,
    );
  }

  // 2) 只有 split.json（没有 cards）→ 至少小说要恢复
  {
    const dir = `${ROOT}/split-only`;
    seed(dir, { split: true, scriptCache: true, cards: false, state: false });
    const r = await restoreProjectState(dir);
    assert(r.novel?.chapters.length === 2, "只有分章缓存时也必须恢复小说");
    assert(r.lastResult === null, "没有卡片、也没有快照时不应伪造 lastResult");
  }

  // 3) 连 split.json 都没有，只剩 cache/ 剧本缓存 → 用章节骨架兜底，保证生成入口还在
  {
    const dir = `${ROOT}/script-cache-only`;
    seed(dir, { split: false, scriptCache: true, cards: true, state: false });
    const r = await restoreProjectState(dir);
    assert(r.novel, "只剩剧本缓存时也要给出章节骨架（否则生成页入口整块消失）");
    assert(r.novel.chapters.length === 2, `应按剧本缓存恢复 2 章，实际 ${r.novel.chapters.length}`);
    assert(
      r.warnings.some((w) => w.includes("缺少项目状态快照")) ||
        r.warnings.some((w) => w.includes("分章缓存")),
      "骨架兜底必须给出可读提示",
    );
  }

  // 4) 完整项目（有快照）→ 行为不变，且不应出现「缺少快照」告警
  {
    const dir = `${ROOT}/complete`;
    seed(dir, { split: true, scriptCache: true, cards: true, state: true });
    const r = await restoreProjectState(dir);
    assert(r.novel?.chapters.length === 2, "完整项目应正常恢复");
    assert(
      !r.warnings.some((w) => w.includes("缺少项目状态快照")),
      "有快照时不应出现「缺少快照」告警",
    );
  }

  // 5) 空目录（真正的无项目）→ 仍然保持 null，不伪造
  {
    const dir = `${ROOT}/empty`;
    mkdirSync(`${dir}/.novel2vn`, { recursive: true });
    const r = await restoreProjectState(dir);
    assert(r.novel === null, "空目录不应被伪造成一个项目");
    assert(r.lastResult === null, "空目录不应有生成结果");
    assert(!r.warnings.some((w) => w.includes("缺少项目状态快照")), "空目录不该提示「按磁盘恢复」");
  }

  rmSync(ROOT, { recursive: true, force: true });
  console.log("=== 无状态快照的项目恢复（#1509 回归）测试通过 ===");
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
