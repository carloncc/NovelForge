import { configState } from "../src/stores/config";
import {
  decideNovelImport,
  removeProjectEntry,
  suggestProjectSubdirName,
  upsertProject,
} from "../src/stores/projects";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  // 导入判定（纯函数）
  assert(decideNovelImport(null, { fileName: "a.txt", titleSig: "一|二" }) === "empty", "无快照应判 empty");
  assert(
    decideNovelImport({ fileName: "a.txt", titleSig: "一|二" }, { fileName: "a.txt", titleSig: "一|二" }) === "same",
    "同名同章应判 same",
  );
  assert(
    decideNovelImport({ fileName: "a.txt", titleSig: "一|二" }, { fileName: "b.txt", titleSig: "一|二" }) === "different",
    "不同名应判 different",
  );
  assert(
    decideNovelImport({ fileName: "a.txt", titleSig: "一|二" }, { fileName: "a.txt", titleSig: "一|三" }) === "same",
    "同文件名应判 same（#1364：titleSig 含 AI 分章后标题/用户改名，同书重导必然不一致，不能据此判不同小说）",
  );

  // 子目录名建议（纯函数）
  assert(suggestProjectSubdirName("我的小说.txt") === "我的小说", "应去后缀保留中文");
  assert(suggestProjectSubdirName("a/b\\c:d.txt") === "c_d", "应取 basename 并清洗非法字符");
  assert(suggestProjectSubdirName("").startsWith("novel-"), "空名应回退时间戳");

  // 注册表增删（以目录为键去重）
  configState.projects = [];
  upsertProject("D:/out/A", { fileName: "甲.txt", title: "卷一" });
  upsertProject("D:/out/B", { fileName: "乙.txt", title: "卷一" });
  upsertProject("D:/out/A", { fileName: "甲.txt", title: "卷二" });
  assert((configState.projects ?? []).length === 2, "同目录重复登记不应新增条目");
  const a = (configState.projects ?? []).find((p) => p.outputDir === "D:/out/A")!;
  assert(a.name === "甲" && a.novelTitle === "卷二", "重复登记应刷新小说信息");
  removeProjectEntry(a.id);
  assert(
    (configState.projects ?? []).length === 1 && (configState.projects ?? [])[0].outputDir === "D:/out/B",
    "移除记录应只删指定条目",
  );
  configState.projects = [];

  console.log("=== project registry tests passed ===");
}

main().catch((error) => {
  console.error("unit-projects failed:", error);
  process.exit(1);
});
