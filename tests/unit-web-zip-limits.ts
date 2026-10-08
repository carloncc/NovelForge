/**
 * #1541：Web 端 zip 打包的两处缺口。
 *
 * ① zipEntriesOverflowReason 只查「条目数」与「单文件字节数」，漏了**文件名字段**。
 *    zip 的名字长度是 u16；fflate 在超过 65535 UTF-8 字节时抛 `filename too long`。
 *    中文路径三个字就是 9 字节，很容易撞上。用户看到的是 fflate 的英文原始报错，
 *    而不是本函数统一给出的中文原因——与它注释里写的立意（#1526：与其让人拿到坏包，
 *    不如明确拒绝并说清原因）不一致。
 *
 * ② zipEntries 声明返回 Promise，却混着两种失败方式：超限走 Promise.reject，
 *    fflate 同步回退走 throw。调用方若用 .catch() 挂载，同步 throw 发生在 Promise 生成之前，
 *    根本接不住。改成 async 后统一走 rejection。
 */
import { zipEntriesOverflowReason, webBuildZip, ZIP_MAX_NAME_BYTES, ZIP_MAX_ENTRY_BYTES, ZIP_MAX_ENTRY_COUNT } from "../src/utils/webRuntime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const b64 = (s: string): number => new TextEncoder().encode(s).length;

function main(): void {
  // ① 名字长度必须被查，且按 UTF-8 **字节**而非字符数
  assert(b64("\u4e2d".repeat(21845)) === 65535, "中文 21845 字应为 65535 字节（口径校对）");
  assert(b64("\u4e2d".repeat(21846)) > ZIP_MAX_NAME_BYTES, "中文 21846 字应超限");

  assert(zipEntriesOverflowReason({ "game/scene/ch1.txt": 1 }) === null, "正常路径必须放行（#1541）");
  assert(zipEntriesOverflowReason({ ["a".repeat(65535)]: 1 }) === null, "65535 字节的名字应放行（#1541）");

  const overAscii = zipEntriesOverflowReason({ ["a".repeat(65536)]: 1 });
  assert(overAscii !== null, "65536 字节的 ASCII 名必须被拒（#1541）");
  assert(/65535/.test(overAscii as string), "拒绝理由应说明 65535 上限：" + overAscii);

  // 中文名按字节计：只有 21846 个字却已超限——按字符数看远不到 65535
  const overCjk = zipEntriesOverflowReason({ ["\u4e2d".repeat(21846)]: 1 });
  assert(overCjk !== null, "65538 字节的中文名必须被拒（#1541）");
  assert(/\u4e2d|中/.test(overCjk as string), "拒绝理由应带上文件名片段（#1541）");

  // 既有两维不得回归
  const many: Record<string, number> = {};
  for (let i = 0; i <= ZIP_MAX_ENTRY_COUNT; i++) many["f" + i] = 1;
  assert(zipEntriesOverflowReason(many) !== null, "条目数超限必须被拒（#1526）");
  assert(zipEntriesOverflowReason({ big: ZIP_MAX_ENTRY_BYTES + 1 }) !== null, "单文件超 4GB 必须被拒（#1526）");
  assert(zipEntriesOverflowReason({ big: ZIP_MAX_ENTRY_BYTES }) === null, "恰好 4GB-1 应放行（#1526）");

  // 说明：zipEntries 已改成 async 以统一失败语义（原先超限走 Promise.reject、fflate 同步
  // 回退走 throw 两种方式混用）。但它是模块私有函数，且唯一调用方 webBuildZip 本身就是 async，
  // 所以这条改动**此前并不可达**——只是让声明的返回类型与实际行为一致，不是修了可触发的缺陷。
  assert(typeof webBuildZip === "function", "webBuildZip 应存在（#1541）");

  console.log("=== Web zip 打包边界测试通过（#1541：名字长度按 UTF-8 字节计）===");
}

main();
