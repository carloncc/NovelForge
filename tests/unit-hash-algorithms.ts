/**
 * #1558：项目里曾有两个**同名同签名、算法却不同**的 `stableHash`。
 *
 *   ids.ts:2    FNV-1a   h = 2166136261; h = Math.imul(h, 16777619)
 *   render.ts   djb2     h = 5381;       h = ((h * 33) ^ charCodeAt) >>> 0
 *
 * 两者对同一输入给出**完全不同的结果**。今天没有跨模块混用（已核：只有 emotions / faceRig /
 * recognize 从 ids.ts 导入，render 那份只在文件内用），所以没有活故障；但这是一个**陷阱**：
 * 将来谁从 `./render` 而不是 `./ids` 导入了 `stableHash`，会静默得到另一套哈希——
 * 表现为「缓存一直不命中」或「素材明明在磁盘上却找不到」。
 *
 * 已把 render.ts 那份按算法改名为 `djb2Hash`，让导入错模块这件事**不可能发生**。
 * 本测试把这条约束钉住。
 */
import { stableHash } from "../src/core/ids";
import { djb2Hash } from "../src/core/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① 两者确实不同（若哪天有人把它们改成一样，说明有人以为它们是同一个东西，需重新审视）
  const samples = ["", "a", "林澈", "scene_1", "sc_a b", "😀emoji", "第1章"];
  const same: string[] = [];
  for (const s of samples) {
    if (stableHash(s) === djb2Hash(s)) same.push(JSON.stringify(s));
  }
  assert(same.length === 0, "两个哈希本应算法不同、结果不同，却出现相同结果（说明被误改成了同一个算法，需确认是否有人当它们可互换）：" + same.join("；") + "（#1558）");

  // ② 各自都是稳定纯函数（同输入同输出、不同输入不同输出）
  for (const fn of [stableHash, djb2Hash]) {
    assert(fn("林澈") === fn("林澈"), "哈希必须是确定性纯函数（#1558）");
    assert(fn("林澈") !== fn("苏晚"), "不同输入应有不同哈希（#1558）");
  }

  // ③ ids 的哈希必须是 FNV-1a 口径——normalizeEntityId 的实体 id 依赖它，
  //    改了会让**所有已生成的实体 id 与缓存键全部失效**（这一条是本测试真正要守住的）。
  //    FNV-1a 32 位对 "a" 的值是 0xe40c292c。
  assert(stableHash("a") === (0xe40c292c >>> 0).toString(36),
    "ids.stableHash 必须是 FNV-1a 口径（改了会让已生成的实体 id/缓存键全部失效），实际 " + stableHash("a") + "（#1558）");

  console.log("=== 两个哈希的口径契约通过（#1558：ids=FNV-1a / render=djb2，已改名防误用）===");
}

main();
