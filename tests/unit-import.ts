import { splitChapters, cleanChapterText } from "../src/core/chapters";
import { decodeNovelBytes, uniqueImportPath } from "../src/utils/vfsWeb";

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

  // #1117：UTF-8 小说直接识别
  {
    const bytes = new TextEncoder().encode("第一章 开始\n这是正文。");
    const r = decodeNovelBytes(bytes.buffer);
    assert(r.encoding === "UTF-8", `UTF-8 应识别，实际 ${r.encoding}`);
    assert(r.text === "第一章 开始\n这是正文。", "UTF-8 文本应原样解码");
  }

  // #1117：GBK 小说（“你好”= C4 E3 BA C3）按 GBK 解码，不出乱码/替换符
  {
    const r = decodeNovelBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer);
    assert(r.encoding === "GBK", `GBK 应识别，实际 ${r.encoding}`);
    assert(r.text === "你好", `GBK 文本应正确解码，实际 ${r.text}`);
  }

  // #1117：BIG5 小说（“中文”= A4 A4 A4 E5）在 GBK 下是干净错字（いゅ），靠 CJK 计数纠正
  {
    const r = decodeNovelBytes(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]).buffer);
    assert(r.encoding === "BIG5", `BIG5 应识别，实际 ${r.encoding}`);
    assert(r.text === "中文", `BIG5 文本应正确解码，实际 ${r.text}`);
  }

  // #1117：空文件回退 UTF-8
  {
    const r = decodeNovelBytes(new Uint8Array([]).buffer);
    assert(r.encoding === "UTF-8" && r.text === "", "空文件应回退 UTF-8 空文本");
  }

  // #1138：同名文件追加 _2/_3 去重；不同名不受影响；无扩展名同样处理
  {
    const used = new Set<string>(["/app/novel/1.txt"]);
    assert(uniqueImportPath(used, "/app/novel", "1.txt") === "/app/novel/1_2.txt", "重名应追加 _2");
    assert(uniqueImportPath(used, "/app/novel", "1.txt") === "/app/novel/1_3.txt", "再次重名应追加 _3");
    assert(uniqueImportPath(used, "/app/novel", "正文.txt") === "/app/novel/正文.txt", "不同名应保持原名");
    assert(uniqueImportPath(used, "/app/novel", "正文") === "/app/novel/正文", "无扩展名应保持原名");
    assert(uniqueImportPath(used, "/app/novel", "正文") === "/app/novel/正文_2", "无扩展名重名应追加 _2");
  }

  console.log("=== 文件导入/切分测试通过 ===");
}

main();
