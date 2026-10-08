/**
 * Node 侧 readTextFile 必须与 Rust 的 read_text_file 同口径地探测编码。
 *
 * 背景：readTextFallback 旧实现是 `new TextDecoder("utf-8").decode(data)` 且恒定返回
 * `encoding: "UTF-8"` —— 对 GBK 文件既产出乱码、又谎报编码。后果不是"少个功能"：
 * 分章快照指纹是 `${fullText.length}:${hash}`，乱码长度对不上 → 快照被判为"源文件已变"
 * 而丢弃，AI 分好的章节退回正则重切。任何 Node 侧无头验证（测试/脚本）都会得出
 * 与应用内相反的结论 —— 本次排查就用它复现出过"30 章变 1 章"的假 bug。
 *
 * 本测试用真实字节锁住：UTF-8 照旧、GBK 认得出、认不出时不谎报。
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tauri } from "../src/utils/tauri";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const dir = await mkdtemp(join(tmpdir(), "novelforge-enc-"));
try {
  // ① UTF-8：行为必须与旧实现完全一致（严格 UTF-8 成功 → 同一结果）
  const utf8Path = join(dir, "utf8.txt");
  await writeFile(utf8Path, "中文测试 UTF-8", "utf-8");
  const a = await tauri.readTextFile(utf8Path);
  assert(a.text === "中文测试 UTF-8", `UTF-8 文件必须原样读出，实际 ${JSON.stringify(a.text)}`);
  assert(a.encoding === "UTF-8", `UTF-8 文件的 encoding 应为 UTF-8，实际 ${a.encoding}`);

  // ② GBK：中=D6D0 文=CEC4 测=B2E2 试=CAD4（标准 GBK 码位）
  const gbkPath = join(dir, "gbk.txt");
  await writeFile(gbkPath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]));
  const b = await tauri.readTextFile(gbkPath);
  assert(b.text.trim() === "中文测试", `GBK 文件必须解码为中文，实际 ${JSON.stringify(b.text)}`);
  assert(b.encoding === "GBK", `GBK 文件的 encoding 应为 GBK（旧实现谎报 UTF-8），实际 ${b.encoding}`);

  // ③ 认不出时不能谎报 UTF-8：0xFF 不是合法 UTF-8，也不是合法 GBK 首字节
  const weirdPath = join(dir, "weird.bin");
  await writeFile(weirdPath, Buffer.from([0xff, 0xfe, 0xff, 0xfe]));
  const c = await tauri.readTextFile(weirdPath);
  assert(c.encoding !== "UTF-8", `无法判定的字节不得谎报 UTF-8，实际 ${c.encoding}`);

  // ④ 回归点：旧实现下 GBK 文件读出的长度是错的（乱码），新实现必须给出正确长度
  assert(
    b.text.length === 5,
    `GBK「中文测试\\n」应解出 5 个字符，实际 ${b.text.length}（旧实现会把 8 字节解成 8 个替换字符）`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("=== readTextFile 编码探测测试通过（UTF-8 照旧 / GBK 认出 / 不谎报）===");
