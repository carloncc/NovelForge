import { splitChapters } from "../src/core/chapters";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 1) 空文本 → 至少一章
  const empty = splitChapters("", "无题");
  assert(empty.length === 1 && empty[0].text === "", "空文本应产生一章空章节");

  // 2) 无章节标题 → 单章
  const plain = splitChapters("第一段。\n\n第二段。", "未命名");
  assert(plain.length === 1 && plain[0].title === "未命名", "无标题应合并为一章且使用文件名");

  // 3) 标准中文章节 → 正确切分
  const novel = "第一章 初见\n内容一\n第二章 离别\n内容二\n第三章\n内容三";
  const chs = splitChapters(novel, "小说");
  assert(chs.length === 3, `应切出 3 章，实际 ${chs.length}`);
  assert(chs[0].title === "第一章 初见" && chs[0].text.includes("内容一"), "第一章切分错误");
  assert(chs[1].title === "第二章 离别", "第二章标题错误");
  assert(chs[2].title === "第三章", "第三章标题错误");

  // 4) 带标点的章节标题
  const dotted = "第1章：启程\n内容A\n第2章·归途\n内容B";
  const d = splitChapters(dotted, "小说");
  assert(d.length === 2, `带标点标题应切 2 章，实际 ${d.length}`);

  // 5) 英文章节标题
  const eng = "Chapter 1\nhello\nChapter 2\nworld";
  const e = splitChapters(eng, "novel");
  assert(e.length === 2 && e[0].title === "Chapter 1", "英文章节切分错误");

  // 6) 卷/回/幕标题
  const vol = "第一卷 风云\n甲\n第二回 突变\n乙\n终章\n丙";
  const v = splitChapters(vol, "小说");
  assert(v.length === 3, `卷/回/终章应切 3 章，实际 ${v.length}`);

  // 7) 普通段落不以章节名开头（不误判）
  const noFalse = "第一章面馆里坐满了人。\n第二章这个标题其实不是章节标题。\n正文";
  const nf = splitChapters(noFalse, "小说");
  assert(nf.length === 1, "长句不应误判为章节标题");

  // 8) 汉字数字章节
  const cnNum = "第十章 结尾\n最后";
  const cn = splitChapters(cnNum, "小说");
  assert(cn.length === 1 && cn[0].title === "第十章 结尾", "汉字数字章节识别错误");

  console.log("=== 章节切分边界测试通过 ===");
}
main();
