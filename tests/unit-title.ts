/**
 * 作品标题解析：文件名常是「175812 gbk」这类垃圾串，不能再当作品名
 *（用户实测：游戏标题/菜单/PWA 显示成了文件名）。
 * 优先级：导出标题 → 卡片标题（过滤垃圾）→ 输出目录名 → 文件名兜底。
 */
import { isJunkTitle, resolveProjectTitle } from "../src/core/title";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// 1) 垃圾标题判定
for (const junk of ["", "   ", "175812", "175812 gbk", "book.gbk", "novel-utf8", "untitled", "copy", "（1）", "12_3"]) {
  assert(isJunkTitle(junk), `应判为垃圾标题：${junk}`);
}
for (const ok of ["成功回避死亡结局的美少女游戏", "灰与幻想的格林姆迦尔 第一卷", "我的日记本"]) {
  assert(!isJunkTitle(ok), `不应判为垃圾标题：${ok}`);
}

// 2) 完整优先级
const dir = "D:/Desktop/视觉小说/成功回避死亡结局的美少女游戏女主们似乎读到了我的【日记本】，并知道了我的秘密";
const resolved = resolveProjectTitle({
  exportTitle: "",
  cardsTitle: "175812 gbk",
  outputDir: dir,
  fileName: "175812 gbk.txt",
});
assert(resolved === "成功回避死亡结局的美少女游戏女主们似乎读到了我的【日记本】，并知道了我的秘密", `应按目录名解析，实际：${resolved}`);

// 3) 导出标题优先
assert(
  resolveProjectTitle({ exportTitle: "正式标题", cardsTitle: "175812 gbk", outputDir: dir, fileName: "175812 gbk.txt" }) === "正式标题",
  "导出标题应最优先",
);

// 4) 卡片标题可用时优先于目录名
assert(
  resolveProjectTitle({ cardsTitle: "卡片标题", outputDir: dir, fileName: "175812 gbk.txt" }) === "卡片标题",
  "可用卡片标题应优先于目录名",
);

// 5) 全垃圾时用文件名兜底（不返回空）
const fallback = resolveProjectTitle({ outputDir: "", fileName: "175812 gbk.txt" });
assert(fallback.length > 0, "兜底标题不应为空");

console.log("=== project title tests passed ===");
