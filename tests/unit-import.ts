import { splitChapters, cleanChapterText } from "../src/core/chapters";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const text = "第一章 开始\n这是正文。\n\n第二章 继续\n更多正文。";
  const chapters = splitChapters(text, "故事");
  assert(chapters.length === 2, "应正常切分出两章");
  assert(chapters[0].title === "第一章 开始", "第一章标题应保留");
  assert(chapters[0].charCount > 0, "第一章应包含正文");
  assert(chapters[1].title === "第二章 继续", "第二章标题应保留");

  const cleaned = cleanChapterText(chapters[0]);
  assert(!cleaned.includes("\r"), "cleanChapterText 应移除回车符");

  const noChapters = splitChapters("没有章节标题的纯文本内容。", "我的故事");
  assert(noChapters.length === 1, "无章节标题时应合并为一章");
  assert(noChapters[0].title === "我的故事", "无章节时应使用书名作为标题");

  console.log("=== 文件导入/切分测试通过 ===");
}

main();
