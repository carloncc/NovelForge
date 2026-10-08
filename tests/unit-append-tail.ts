/**
 * #1519：增量追加时，若用户选中的正是本项目已导入的那份原文文件，不得把整份文件再拼一遍。
 *
 * 真实操作序列：导入 novel.txt → 把第 4、5 章写进**同一个** novel.txt → 点「增量追加」
 * 又选中 novel.txt。旧实现无条件把所选文件整份当作「新增内容」拼到原文后面，于是全文重复、
 * 分章/提取/剧本/图像对着重复内容重跑一遍（真实计费）；而 sourcePaths 里本就有该路径、
 * 不会新增，重启后按源文件重新导入又变回未重复的版本，内存与磁盘长期不一致。
 */
import { normalizeNovelText, resolveAppendTail } from "../src/core/chapters";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ORIGINAL = "第一章\n\n正文一。\n\n第二章\n\n正文二。";
const ADDED = "第三章\n\n正文三。";

function main(): void {
  // 1) 选的是新文件：原样作为新增内容
  {
    const r = resolveAppendTail(ADDED, ORIGINAL, false, false);
    assert(r.ok, "新文件应可追加");
    assert(r.tail === ADDED, "新文件的正文应原样作为尾部");
  }

  // 2) 核心回归：选的就是已导入的原文，且新章节接在原文末尾 → 只取真正多出来的部分
  {
    const fileContent = `${ORIGINAL}\n\n${ADDED}`;
    const r = resolveAppendTail(fileContent, ORIGINAL, true, false);
    assert(r.ok, "原文末尾追加了新章节时应当可以追加");
    assert(r.tail === ADDED, `应只取新增部分，实际取到 ${r.tail.length} 字（原文共 ${ORIGINAL.length} 字）`);
    // 收敛性：拼回去必须与磁盘上的文件内容一致，重启重导才不会指纹失配
    const memory = `${normalizeNovelText(ORIGINAL)}\n\n${r.tail}`;
    assert(
      memory === normalizeNovelText(fileContent),
      "追加后的内存全文必须与源文件归一化结果一致，否则重启重导会指纹失配并作废缓存",
    );
  }

  // 3) 选的就是已导入的原文，但内容没变 → 明确拒绝，不做无意义追加
  {
    const r = resolveAppendTail(ORIGINAL, ORIGINAL, true, false);
    assert(!r.ok && r.reason === "same", "原文无新增内容时应拒绝");
  }

  // 4) 原文中间被改动过（不是「末尾追加」形态）→ 拒绝，否则会拼出重复正文
  {
    const edited = `第一章（改过）\n\n正文一。\n\n第三章\n\n正文三。`;
    const r = resolveAppendTail(edited, ORIGINAL, true, false);
    assert(!r.ok && r.reason === "notSuffix", "原文中间被改动时应拒绝追加");
  }

  // 5) 多文件原文之一：无法用前缀判断增量，一律拒绝（否则整份重复）
  {
    const r = resolveAppendTail(`${ORIGINAL}\n\n${ADDED}`, `${ORIGINAL}\n\n第二章续`, true, true);
    assert(!r.ok && r.reason === "multiSource", "多文件原文之一应拒绝追加");
  }

  // 6) 空/纯空白
  {
    assert(!resolveAppendTail("", ORIGINAL, false, false).ok, "空文件应拒绝");
    assert(!resolveAppendTail("  \n \n ", ORIGINAL, false, false).ok, "纯空白文件应拒绝");
  }

  // 7) BOM 与 CRLF 必须与导入链同一口径。
  // 注意：BOM 这条**不是**靠 normalizeNovelText 里那句 /^﻿/ 兜住的——U+FEFF 是
  // ECMAScript 定义的空白字符，.trim() 本来就会剥掉它；实测把那句 replace 删掉、
  // 退回调用点的内联副本（只做 \r 与 3+ 换行），本测试依旧通过。所以这里断言的是
  // **最终行为**（BOM 不得进入正文），而不是某一行实现——负控测过，确实等价。
  {
    const bomFile = `\uFEFF${ADDED}`;
    const r = resolveAppendTail(bomFile, ORIGINAL, false, false);
    assert(r.ok, "带 BOM 的新增文件不应被拒");
    assert(!r.tail.startsWith("\uFEFF"), "BOM 必须被剥离（中文 Windows 记事本默认写 BOM）");
    const crlf = resolveAppendTail("第三章\r\n\r\n\r\n\r\n正文三。", ORIGINAL, false, false);
    assert(crlf.ok && crlf.tail === "第三章\n\n正文三。", `CRLF 与 3+ 空行应被归一化，实际 ${JSON.stringify(crlf.ok ? crlf.tail : crlf.reason)}`);
  }

  // 8) 已导入的原文里只有空行差异，也应判定为「没有新增」。
  // 归一化已经 trim 掉尾部空行，所以这里命中的是 "same" 而不是 "empty"——两者对上层都是拒绝。
  {
    const r = resolveAppendTail(`${ORIGINAL}\n\n\n\n`, ORIGINAL, true, false);
    assert(!r.ok && (r.reason === "same" || r.reason === "empty"), `只有空行增量时应判为无新增内容，实际 ${r.ok ? "ok" : r.reason}`);
  }

  console.log("=== 增量追加尾部解析测试通过（#1519）===");
}

main();
