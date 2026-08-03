import { saveProjectState, restoreProjectState } from "../src/utils/persist";
import { tauri } from "../src/utils/tauri";
import type { MaterialAsset } from "../src/core/types";
import { writeFile } from "node:fs/promises";

const DIR = "/tmp/novelforge-persist-test";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  await tauri.removePath(DIR).catch(() => {});
  await tauri.mkdirAll(DIR);

  // 准备一个真实的小说源文件
  const novelPath = `${DIR}/小说.txt`;
  await writeFile(novelPath, "第一章 初见\n林澈:你好;\n第二章 再见\n苏晚晴:再见;", "utf-8");
  const { importNovelFile, splitChapters } = await import("../src/core/chapters");

  const novel = await importNovelFile(novelPath);
  novel.chapters[0].title = "第一章 改过的标题";
  novel.chapters[1].enabled = false;

  const materials: MaterialAsset[] = [
    { name: "林澈.png", path: `${DIR}/林澈.png`, kind: "character", mime: "image/png", extra: { mapTo: "linche" } },
  ];
  const options = {
    useImage: true,
    useTts: false,
    imageBudgetPerChapter: 12,
    cgPerChapter: 3,
    skipCache: false,
    maxConcurrent: 2,
    videoPointsPerChapter: 2,
    characterIntroCard: true,
  };

  await saveProjectState({ novel, materials, outputDir: DIR, options, lastResult: null });

  // 模拟重新启动：重新读文件并恢复
  const restored = await restoreProjectState(DIR);
  assert(restored.novel !== null, "小说应恢复");
  assert(restored.novel!.chapters[0].title === "第一章 改过的标题", "章节标题编辑应保留");
  assert(restored.novel!.chapters[1].enabled === false, "章节启用状态应保留");
  assert(restored.novel!.chapters.length === 2, "章节数应保留");
  assert(restored.materials.length === 1 && restored.materials[0].extra?.mapTo === "linche", "素材与映射应保留");
  assert(restored.options?.cgPerChapter === 3, "选项应保留");
  assert(restored.options?.videoPointsPerChapter === 2, "新增选项应保留");

  // 源文件不存在时安全返回空
  const gone = await restoreProjectState("/tmp/novelforge-persist-missing");
  assert(gone.novel === null && gone.materials.length === 0, "无状态目录应返回空");

  console.log("=== 状态持久化测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
