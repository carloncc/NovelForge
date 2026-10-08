/**
 * #1564：网页版导入路径的**净化**契约。
 *
 * 背景（上一轮 flag、本轮结清）：Web VFS 是扁平 key 存储，`normalizeVfsPath` **不折叠 `..`**
 * （Rust 侧有 canonicalize + 根校验，Web 没有）。当时列的后续检查项是「若某入口能把含 `..` 的段
 * 写进 VFS，打包产物就会带 `../x` 条目名 → 解压时 zip-slip」。本轮把该入口逐一查完：
 *
 *   1. 本应用**没有任何解压/导入 zip 的路径**——fflate 只用到 `zipSync`（产出游戏包），无 unzip；
 *   2. 也没有用 `webkitRelativePath`；
 *   3. 唯一从外部取名的入口是 uniqueImportPath(file.name)，而它会 `split(/[\\/]/).pop()` **只取基名**。
 *
 * 所以「`..` 进入 VFS」**不可达**，zip-slip 那条不成立。本测试把第 3 条（真正起净化的那一句）钉住——
 * 它一旦被改成直接拼 fileName，整条结论就会失效。
 */
import { uniqueImportPath } from "../src/utils/vfsWeb";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 路径里不得出现 `..` 段（也不得出现任何以 . 开头的段） */
function hasDotSegment(p: string): boolean {
  return p.split("/").some((seg) => seg.startsWith("."));
}

function main(): void {
  const DIR = "/app/novel";

  // ① 最关键：带目录穿越成分的文件名必须被压成基名
  for (const evil of ["../../evil.txt", "..\\..\\evil.txt", "/etc/passwd", "a/b/../c.txt", "sub/dir/file.png"]) {
    const used = new Set<string>();
    const v = uniqueImportPath(used, DIR, evil);
    assert(v.startsWith(DIR + "/"), "结果必须落在目标目录下，实际 " + v + "（来自 " + evil + "）（#1564）");
    assert(!hasDotSegment(v), "结果不得含以 . 开头的段（`..` 即其中一种），实际 " + v + "（来自 " + evil + "）（#1564）");
  }

  // ② 具体化：../../evil.txt → /app/novel/evil.txt
  assert(uniqueImportPath(new Set(), DIR, "../../evil.txt") === "/app/novel/evil.txt",
    "「../../evil.txt」必须压成基名 evil.txt（#1564）");

  // ③ 同名去重仍要正常（_2/_3…）
  const used = new Set<string>();
  const a = uniqueImportPath(used, DIR, "1.txt");
  const b = uniqueImportPath(used, DIR, "1.txt");
  assert(a === "/app/novel/1.txt" && b === "/app/novel/1_2.txt", "同名应追加 _2，实际 " + a + " / " + b + "（#1564）");

  // ④ 空名/纯分隔符要有兜底，不能产出以 / 结尾的目录式 key
  const e = uniqueImportPath(new Set(), DIR, "");
  assert(e === "/app/novel/novel.txt", "空文件名应兜底为 novel.txt，实际 " + e + "（#1564）");
  const s = uniqueImportPath(new Set(), DIR, "../../");
  assert(!s.endsWith("/") && s.startsWith(DIR + "/"), "纯分隔符不得产出目录式 key，实际 " + s + "（#1564）");

  console.log("=== 导入路径净化契约通过（#1564：只取基名，`..` 无法进入 VFS）===");
}

main();
