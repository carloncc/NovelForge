/**
 * #1524：抠图模型登记表 TS ↔ Rust 必须逐条一致。
 *
 * Rust 的 KNOWN_MODELS 注释自己写着「与前端 src/core/cutout/models.ts 保持一致；
 * 新增模型时两边都要改」，但没有任何机制保证——与 #1517（WebGAL 版本）是同一类手工同步。
 *
 * 不同步的后果不是显示错：桌面端的 model_integrity 对**登记表外**的文件会跳过
 * 「期望大小 ×1.2」的不完整判定，max_bytes_for 也退回统一的 330MB 上限；
 * resolve_download_md5 则转而信任调用方传入的 md5。等于新增模型时只在一边登记，
 * 桌面端的完整性校验就悄悄降级了。
 */
import { readFileSync } from "node:fs";
import { CUTOUT_MODELS } from "../src/core/cutout/models";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = process.cwd().replace(/\\/g, "/");

function main(): void {
  const rust = readFileSync(`${ROOT}/src-tauri/src/models.rs`, "utf8").replace(/\r\n/g, "\n");

  // Rust 侧：KNOWN_MODELS 表里的 ("filename", size_mb, "md5"),
  const table = /KNOWN_MODELS:\s*&\[\(&str,\s*u64,\s*&str\)\]\s*=\s*&\[([\s\S]*?)\];/.exec(rust);
  assert(table, "未在 models.rs 里定位到 KNOWN_MODELS 表，扫描规则失效");
  const rustRows = [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*"([^"]+)"\s*\)/g)].map((m) => ({
    filename: m[1],
    sizeMB: Number(m[2]),
    md5: m[3].toLowerCase(),
  }));
  assert(rustRows.length > 0, "Rust 表解析出 0 行，扫描规则失效");

  const tsRows = CUTOUT_MODELS.map((m) => ({
    filename: m.filename,
    sizeMB: m.sizeMB,
    md5: (m.md5 ?? "").toLowerCase(),
  }));
  assert(tsRows.length > 0, "前端模型表为空，扫描规则失效");

  const rustByName = new Map(rustRows.map((r) => [r.filename, r]));
  const tsByName = new Map(tsRows.map((r) => [r.filename, r]));

  // ① 两个方向都不能多出对方没有的条目
  for (const r of tsRows) {
    assert(
      rustByName.has(r.filename),
      `前端新增了模型 ${r.filename}，但 Rust KNOWN_MODELS 没有登记——桌面端会跳过完整性校验（#1524）`,
    );
  }
  for (const r of rustRows) {
    assert(
      tsByName.has(r.filename),
      `Rust KNOWN_MODELS 有 ${r.filename}，但前端 CUTOUT_MODELS 没有——两端模型清单已分叉（#1524）`,
    );
  }

  // ② 逐条比对大小与 md5
  for (const t of tsRows) {
    const r = rustByName.get(t.filename)!;
    assert(
      r.sizeMB === t.sizeMB,
      `${t.filename} 体积不一致：前端 ${t.sizeMB} MB / Rust ${r.sizeMB} MB（会误判「文件不完整」）（#1524）`,
    );
    assert(t.md5.length === 32, `${t.filename} 前端缺少 32 位 md5（#1524）`);
    assert(
      r.md5 === t.md5,
      `${t.filename} md5 不一致：前端 ${t.md5} / Rust ${r.md5}（下载校验会永远失败）（#1524）`,
    );
  }

  console.log(`=== 抠图模型登记表口径测试通过（#1524，${tsRows.length} 个模型）===`);
}

main();
