/**
 * #1569：HTTP 状态错误必须**只有一份实现**，且 `status` 必须真的被分类器用上。
 *
 * 原先 openaiCompatible.ts 与 universal.ts 各有一份 `httpStatusError`（实测逐字相同，故无故障）。
 * 但 classifyError 的「状态码 + 文本」双信号分类**完全依赖 .status 被挂上**——只改一处、另一处漏改，
 * 那条路径就静默退化成纯文本分类，而 408/425 这类错误**只能靠状态码**区分（文本里没有任何线索）。
 *
 * 本测试把「抛出端」与「分类端」连起来断言——这正是两份实现漂移时会断掉的链条。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { httpStatusError } from "../src/api/universal";
import { classifyError } from "../src/utils/errorClassifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① 形态：必须是带 .status 的 Error（而不是裸对象）
  const e = httpStatusError(503, "boom");
  assert(e instanceof Error, "必须抛 Error（保留调用栈）（#1569）");
  assert((e as { status?: number }).status === 503, "必须挂上 .status，实际 " + String((e as { status?: number }).status) + "（#1569）");

  // ② 端到端：分类器要能凭这个 status 得出正确类别（这才是挂 status 的意义）。
  //    注意 classifyError 的 status 是**第二个参数**，它不会自己去读 e.status——
  //    调用方必须显式取出（已核：openaiCompatible.ts:493、universal.ts:655 两处都取了）。
  //    本测试就按调用方的真实姿态来传，否则测的是「没人用的用法」。
  const withStatus = (st: number, msg = "boom") => {
    const err = httpStatusError(st, msg);
    return classifyError(err, (err as { status?: number }).status);
  };
  assert(withStatus(503) === "network", "503 应判 network（#1569）");
  assert(withStatus(429) === "rate_limit", "429 应判 rate_limit（#1569）");
  assert(withStatus(401) === "auth", "401 应判 auth（#1569）");
  // ③ 关键反例：408/425 的报文里**没有任何中文/英文线索**，只能靠状态码
  assert(withStatus(408) === "network",
    "408 只能靠状态码判 network（文本是 boom）；status 丢了就会落 unknown（#1569）");
  assert(withStatus(425) === "network", "425 同理（#1569）");
  assert(classifyError(new Error("boom")) === "unknown",
    "对照：同样文本但不挂 status/不传 status 时应落 unknown——证明上面几条确实是 status 起的作用（#1569）");

  // ④ 源码契约：全仓只允许一处定义
  const defs: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "target", ".git", "dist"].includes(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.ts$/.test(ent.name) && /function\s+httpStatusError\s*\(/.test(readFileSync(p, "utf8"))) {
        defs.push(p.slice(process.cwd().length + 1));
      }
    }
  };
  walk(join(process.cwd(), "src"));
  assert(defs.length === 1, "httpStatusError 只允许一处定义，实际 " + defs.length + " 处：" + defs.join("、") + "（#1569）");

  console.log("=== HTTP 状态错误唯一实现且 status 生效（#1569：定义处 " + defs[0] + "）===");
}

main();
