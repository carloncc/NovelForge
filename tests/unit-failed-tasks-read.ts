/**
 * #1530：readFailedTasks 必须把手改/损坏的 failed.json 条目补全成合法 FailedTask。
 *
 * #1311 当时的问题是缺 message 会让 identity 里的 .split 崩掉整个读取。
 * 现在 identity 自己也有 `?? ""` 兜底（两道防线），所以删掉读取时的补全**行为等价**——
 * 但那正是它脆弱的地方：只剩一道防线时，任何新写的 `f.message.split(...)` 都会重新引崩。
 * 本测试把「读取即补全」这条契约钉住，让第二道防线不能被悄悄拆掉。
 */
import { tauri } from "../src/utils/tauri";
import { readFailedTasks, failedTasksFile } from "../src/core/failedTasks";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const dir = "/proj";
  const file = failedTasksFile(dir);
  const payload = [
    { id: "a", kind: "image", step: "图像", at: 1 },                    // 缺 message
    { id: "b", kind: "image", step: "图像", message: "背景-b：x", at: 2 }, // 正常
    { id: "c", kind: "image", step: "图像", message: 123, at: 3 },        // 类型坏
    { kind: "image", step: "图像" },                                     // 缺 id，应被过滤
    null,
  ];
  const origExists = tauri.pathExists;
  const origRead = tauri.readTextFile;
  tauri.pathExists = async () => true;
  tauri.readTextFile = async () => ({ text: JSON.stringify(payload) }) as never;
  let out;
  try {
    out = await readFailedTasks(dir);
  } finally {
    tauri.pathExists = origExists;
    tauri.readTextFile = origRead;
  }
  void file;
  assert(out.length === 3, `缺 id/null 的条目应被过滤，期望剩 3 条，实得 ${out.length} 条（#1530）`);
  out.forEach((f, i) => {
    assert(typeof f.message === "string", `第 ${i} 条 message 应被补成字符串，实得 ${typeof f.message}（#1530）`);
  });
  assert(out[0].message === "", `缺 message 应补空串，实得 ${JSON.stringify(out[0].message)}（#1530）`);
  assert(out[1].message === "背景-b：x", "正常 message 不应被改动");
  assert(out[2].message === "", `message 类型非字符串应补空串，实得 ${JSON.stringify(out[2].message)}（#1530）`);
  console.log("=== failedTasks 读取补全测试通过（#1530：缺/坏 message 一律补空串，缺 id 条目过滤）===");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
