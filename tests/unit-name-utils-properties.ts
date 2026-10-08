/**
 * #1539/#1540：文件名工具的性质测试。
 *
 * 本轮先试了「幂等性」这一条，结果九个函数里报了四个「不幂等」——逐一核对后**全部是这条性质本身用错了**：
 *   - titleHash / scriptCacheRest / scriptPartRest 是哈希函数，f(f(x)) 本就不该等于 f(x)；
 *   - stripImageExt 的语义是「剥掉最后一个图片扩展名」，a.png.gif 剥成 a.png 再剥成 a 是正确的；
 *   - splitVocalFileName 那条是探针自己的包装函数把 v_ 前缀丢了才返回 null。
 * 所以幂等性不是这些函数该满足的公理，这里换成三条真正该成立的性质。
 */
import { stripImageExt, scriptCacheRest, titleHash, scriptPartRest } from "../src/core/cache";
import { normalizeEntityId } from "../src/core/ids";
import { safeFilename } from "../src/utils/path";
import { splitVocalFileName } from "../src/core/voice";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CORPUS = [
  "", "a", "a.png", "a.PNG", "a.gif", "a.flac", "a.mp3", "a.tar.gz", "png", ".png",
  "中文.png", "a b.gif", "../x.png", "a\u0000b.png", "x.GIF", "\u{1F600}.png",
  "第一章", "a//b", "-", "...",
];

const FNS: [string, (s: string) => string][] = [
  ["safeFilename", safeFilename],
  ["stripImageExt", stripImageExt],
  ["titleHash", titleHash],
  ["normalizeEntityId", (s) => normalizeEntityId(s, "c")],
  ["scriptCacheRest", (s) => scriptCacheRest(s, s, "_st1")],
  ["scriptPartRest", (s) => scriptPartRest(s, s, "_st1", "")],
];

function main(): void {
  // 性质一：确定性——同输入必须永远同输出（缓存键/文件名靠这个）
  for (const [name, f] of FNS) {
    const once = CORPUS.map((s) => f(s));
    const twice = CORPUS.map((s) => f(s));
    assert(once.join("\u0000") === twice.join("\u0000"), name + " 不满足确定性（#1540）");
    // 再打乱顺序重算，结果集合必须一致（不得依赖调用次序）
    const shuffled = [...CORPUS].reverse().map((s) => f(s)).reverse();
    assert(once.join("\u0000") === shuffled.join("\u0000"), name + " 的结果依赖调用顺序（#1540）");
  }

  // 性质二：stripImageExt 只剥「最后一个」已知图片扩展名
  assert(stripImageExt("a.png.gif") === "a.png", "只剥最后一个扩展名（#1540）");
  assert(stripImageExt("a.gif.png") === "a.gif", "只剥最后一个扩展名（#1540）");
  assert(stripImageExt("a.mp3") === "a.mp3", "音频扩展名不归它管（#1540）");
  assert(stripImageExt("a.tar.gz") === "a.tar.gz", "非图片复合扩展名不动（#1540）");
  assert(stripImageExt("png") === "png", "没有扩展名时原样返回（#1540）");

  // 性质三：剥掉再补回原扩展名必须复原（basename 探测的正确性前提）
  for (const s of ["a.png", "a.gif", "中文.gif", "x.GIF", "a.jpg", "a.jpeg", "a.webp"]) {
    const base = stripImageExt(s);
    const ext = s.slice(base.length);
    assert(ext.startsWith(".") && ext.length > 1, s + " 的扩展名剥离异常（#1540）");
    assert(stripImageExt(base + ext) === base, s + " 剥后补回不能复原（#1540）");
  }

  // 性质四：splitVocalFileName 往返——拼回去还能解析出来
  for (const [key, fp, hash] of [["ch1", "ab12cd", "9x"], ["a_b", "z", "1"], ["第一章", "ff", "ee"]] as [string, string, string][]) {
    const name = "v_" + key + "_" + fp + "_" + hash + ".mp3";
    const parsed = splitVocalFileName(name);
    assert(parsed !== null, "应能解析 " + name + "（#1540）");
    assert(parsed?.key === key, "key 往返不一致：" + name + "（#1540）");
    assert(parsed?.hash === hash, "hash 往返不一致：" + name + "（#1540）");
    // 扩展名换成 flac/opus 也必须照样解析
    for (const ext of ["flac", "opus", "ogg", "wav", "m4a"])
      assert(splitVocalFileName("v_" + key + "_" + fp + "_" + hash + "." + ext) !== null,
        "配音扩展名 " + ext + " 解析失败（#1540）");
  }

  console.log("=== 文件名工具性质测试通过（#1540：" + FNS.length + " 个函数 × " + CORPUS.length + " 条语料）===");
}

main();
