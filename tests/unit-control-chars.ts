/**
 * #1535：控制字符与敌意 Unicode 的边界测试。
 *
 * 小说文本是用户输入，会带 RTL 覆写、零宽字符、BOM、组合字符、NUL 等。
 * 本轮探针发现 safeFilename 与 sanitizeLogText 都只洗了分隔符/空白，
 * NUL 等 C0 控制字符原样透传——Windows 的 CreateFileW 按 NUL 截断路径，
 * a+NUL+b 实际落到磁盘上是 a，两个不同名字映射到同一文件、按全名查找永远 miss。
 */
import { safeFilename } from "../src/utils/path";
import { sanitizeLogText, truncate } from "../src/utils/logger";
import { titleHash, scriptCacheFileName } from "../src/core/cache";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CTRL_RE = /[\u0000-\u001f\u007f]/;

function main(): void {
  // ① safeFilename 不得吐出控制字符、路径分隔符
  for (const raw of ["a\u0000b", "a\u0001b", "a\u001bb", "a\u007fb", "a\rb", "a\nb", "a\tb"]) {
    const out = safeFilename(raw);
    assert(!CTRL_RE.test(out), "safeFilename 仍保留控制字符: " + JSON.stringify(raw) + " -> " + JSON.stringify(out) + "（#1535）");
    assert(!/[\\/:*?"<>|]/.test(out), "safeFilename 仍保留路径分隔符: " + JSON.stringify(raw) + "（#1535）");
    assert(out.length > 0, "safeFilename 返回了空名: " + JSON.stringify(raw) + "（#1535）");
  }
  for (const raw of ["../../etc/passwd", "a/b/c", "\u0000../x", "..", ".", "...."]) {
    // 判据不是「结果里不能出现两个点」——分隔符已被折成下划线，../../etc/passwd 会变成
    // _.._.._etc_passwd，那是**单个文件名**、不可能构成路径段。真正要保证的是：
    // 分隔符不残留，且整体不等于 . / ..。
    const out = safeFilename(raw);
    assert(!/[\\/]/.test(out), "safeFilename 仍含分隔符: " + JSON.stringify(raw) + "（#1535）");
    assert(out !== "." && out !== "..", "safeFilename 结果仍是纯点路径: " + JSON.stringify(raw) + "（#1535）");
  }

  // ② sanitizeLogText 必须洗掉全部 C0/DEL（含原已覆盖的 CR/LF）
  for (const raw of ["a\u0000b", "a\u0007b", "a\u001bb", "a\u007fb", "a\r\nb", "a\nb", "a\rb"])
    assert(!CTRL_RE.test(sanitizeLogText(raw)),
      "sanitizeLogText 仍保留控制字符: " + JSON.stringify(raw) + " -> " + JSON.stringify(sanitizeLogText(raw)) + "（#1535）");
  assert(sanitizeLogText("a\r\nb") === "a b", "CRLF 压平行为不得回归（1317）");
  assert(sanitizeLogText("y".repeat(3000)).length === 2001, "超长限长不得回归（1317）");

  // ③ 缓存文件名只由哈希构成，敌意 Unicode 不得混进文件名
  for (const raw of ["\u202Egnp.exe", "a\u200Bb", "\uFEFFabc", "a\u0000b", "\u{1F600}"])
    assert(!CTRL_RE.test(scriptCacheFileName("/cache", false, 0, raw, "正文", "")),
      "缓存文件名混进控制字符（#1535）");

  // ④ titleHash 对零宽/RTL/BOM 敏感 → 视觉相同的标题算出不同缓存键（多跑一次，不是数据损坏）。
  //    钉住「现状」：将来若引入 Unicode 归一化，这条会提示同步更新调用方的去重口径。
  assert(titleHash("ab") !== titleHash("a\u200Bb"), "零宽字符当前会改变哈希（现状钉住，#1535）");
  assert(titleHash("abc") !== titleHash("\uFEFFabc"), "BOM 当前会改变哈希（现状钉住，#1535）");
  assert(titleHash("abc") !== titleHash("a\u0000bc"), "NUL 当前会改变哈希（现状钉住，#1535）");

  // ⑤ truncate 是截断不是清洗（与 sanitizeLogText 职责不同）
  assert(truncate("abc", 200) === "abc", "truncate 短串应原样返回");

  console.log("=== 控制字符/敌意 Unicode 边界测试通过（#1535）===");
}

main();
