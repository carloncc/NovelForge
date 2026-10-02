import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tauri } from "../src/utils/tauri";
import { composeAppendPayload } from "../src/utils/logFile";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * #1502 回归：日志落盘改为「追加」。
 *
 * 旧的写盘路径是 `读全量 → 拼新内容 → 写全量`，成本随日志体积增长；
 * 新的 append 路径成本只与新增行数成正比。这里锁住两点：
 *  1) 追加结果与旧的「读改写」逐字一致（分隔符、结尾不加换行）；
 *  2) 能创建不存在的文件与父目录（日志文件首次落盘）。
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "novelforge-logfile-"));
  try {
    const file = join(root, "logs", "novelforge.log").replace(/\\/g, "/");

    // 1) 不存在的文件 + 不存在的父目录：应自动创建并写入
    await tauri.appendTextFile(file, "[t1][INFO][app] first");
    assert((await readFile(file, "utf-8")) === "[t1][INFO][app] first", "首次追加应创建文件并写入内容（无尾随换行）");

    // 2) 原始追加是纯 O_APPEND：不自己加分隔符，内容原样落到文件末尾
    await tauri.appendTextFile(file, "\n[t2][INFO][app] second");
    assert(
      (await readFile(file, "utf-8")) === "[t1][INFO][app] first\n[t2][INFO][app] second",
      "追加应把内容原样写到末尾（分隔符由调用方决定）",
    );

    // 2b) 分隔符由 composeAppendPayload 负责，且必须与旧实现逐字一致
    assert(composeAppendPayload(false, "[a]") === "[a]", "空文件追加不得补前导换行（否则日志开头多一条空行）");
    assert(composeAppendPayload(true, "[b]") === "\n[b]", "非空文件追加必须用单个换行分隔");
    assert(!composeAppendPayload(true, "[b]").endsWith("\n"), "追加负载结尾不得补换行（旧实现不留尾空行）");
    assert(composeAppendPayload(true, "") === "", "空块不应产生任何输出（避免只追加一个换行）");

    // 3) 对照实现：旧的「读 + 拼 + 写」结果必须与新路径完全相同
    const legacy = join(root, "legacy.log").replace(/\\/g, "/");
    const oldWay = async (p: string, chunk: string): Promise<void> => {
      let existing = "";
      try {
        existing = await readFile(p, "utf-8");
      } catch {
        /* 不存在 */
      }
      await writeFile(p, existing ? `${existing}\n${chunk}` : chunk, "utf-8");
    };
    await oldWay(legacy, "[t1][INFO][app] first");
    await oldWay(legacy, "[t2][INFO][app] second");
    assert(
      (await readFile(file, "utf-8")) === (await readFile(legacy, "utf-8")),
      "append 路径的输出必须与旧的读改写路径逐字一致",
    );

    // 4) 多行块追加（日志是成块 flush 的）：块内换行原样保留，块间只多一个分隔换行
    await tauri.appendTextFile(file, composeAppendPayload(true, "[t3]\n[t4]"));
    assert(
      (await readFile(file, "utf-8")).endsWith("[t2][INFO][app] second\n[t3]\n[t4]"),
      "多行块追加应保持块内换行，块间只加一个分隔换行",
    );

    console.log("=== 日志追加写入（#1502 回归）测试通过 ===");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
