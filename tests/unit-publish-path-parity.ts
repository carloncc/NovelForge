/**
 * #1536：跨语言差分——「点文件不进包」这条规则在三个地方各有一份实现：
 *   1. Rust 预览服务器  server.rs::is_preview_blocked（Path::components + starts_with('.')）
 *   2. Rust 打包器      commands.rs::write_zip_contents（逐层 name.starts_with('.')）
 *   3. TS Web 打包器    vfsWeb.ts::isPublishableRelativePath（split("/") + startsWith(".")）
 *
 * 三份一旦漂移，就是「桌面版拦住了、Web 版没拦住」的隐私缺口（#1522 的原始问题）。
 *
 * 差分结果（本轮实测）：核心语义一致，存在两处 TS 侧**更严**的差异——
 *   a. CurDir 段：Rust 的 components() 会把 "." 归一化掉，TS 则因 "." 以点开头而拦下，
 *      于是 "./a/b.txt"、"a/./b.txt"、"." 在 Rust 侧放行、TS 侧拦下。
 *   b. 反斜杠：Rust 在 Windows 上同时按 / 和 \\ 切分，TS 只按 /。
 * 两处都**不可达**：vfsWeb 的 key 一律经 normalizeVfsPath 归一化（[\\/] 切分、滤空段、
 * 用 / 拼接），key 里既不会有反斜杠，也不会有 "." 这类纯点段。
 *
 * 因此断言取「TS 不得比 Rust 更宽松」——这是安全方向上真正需要保证的不变式，
 * 比要求两者逐字节相同更准确，也不会逼着两边为一个不可达形状写分支。
 */
import { isPublishableRelativePath } from "../src/utils/vfsWeb";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 忠实还原 Rust Path::components() 在 Windows 上的切分与 CurDir 归一化 */
function rustAllows(relative: string): boolean {
  const parts = relative.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
  return !parts.some((c) => c.startsWith("."));
}

/** vfsWeb.normalizeVfsPath 之后的真实 key 形状：只有 / 分隔、没有纯点段 */
const REACHABLE: string[] = [
  "index.html",
  "game/scene/start.txt",
  "game/vocal/ch1.mp3",
  ".env",
  ".git/config",
  ".gitignore",
  "a/.cache/x.json",
  "a/b/.idea/workspace.xml",
  ".novel2vn/failed.json",
  "not.novel2vn/f.json",
  "xnode_modules/y.js",
  "a//b//c.txt",
  "../escape.txt",
  "a/../b.txt",
  "..",
  "...",
  "..hidden/x",
  "UPPER/.ENV",
  "space name/file.txt",
  "中文/章节.txt",
  "deep/.a/.b/.c/leaf.txt",
];

/** 归一化后不可能出现的形状：反斜杠 / CurDir 段。TS 侧可以更严，但绝不能更松。 */
const EDGE_SHAPES: string[] = [
  "./a/b.txt",
  "a/./b.txt",
  ".",
  "a\\.env",
  "x\\..\\y",
];

function main(): void {
  for (const rel of REACHABLE) {
    const ts = isPublishableRelativePath(rel);
    const rust = rustAllows(rel);
    assert(ts === rust, "真实可达路径上 TS 与 Rust 口径不一致：" + JSON.stringify(rel)
      + " TS=" + ts + " Rust=" + rust + "（#1536）");
  }

  for (const rel of EDGE_SHAPES) {
    const ts = isPublishableRelativePath(rel);
    const rust = rustAllows(rel);
    assert(!ts || rust, "TS 比 Rust 更宽松（安全方向失守）：" + JSON.stringify(rel)
      + " TS=" + ts + " Rust=" + rust + "（#1536）");
  }

  assert(!isPublishableRelativePath(".env"), ".env 必须拦（#1536）");
  assert(!isPublishableRelativePath("a/.env"), "子目录 .env 必须拦（#1522 原始问题）");
  assert(isPublishableRelativePath("not.novel2vn/f.json"), "not.novel2vn 不是点文件，应放行（#1116）");
  assert(isPublishableRelativePath("xnode_modules/y.js"), "xnode_modules 不是点文件，应放行（#1116）");

  console.log("=== 跨语言差分测试通过（#1536：可达 " + REACHABLE.length
    + " 条逐条相等 + 不可达 " + EDGE_SHAPES.length + " 条 TS 不比 Rust 宽松）===");
}

main();
