import { sliceBase64Head } from "../src/utils/tauri";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * #1503 回归：Web/Node 端此前为解析图片尺寸会 readFileBase64 读**整张图**（Tauri 侧早已只读头部）。
 * 现改为拿到 base64 后立刻截断到「足够解析文件头」的前缀。这里锁住截断规则：
 *  - 结果必须能被解码（长度是 4 的倍数，且不含不完整 quartet）
 *  - 小图原样返回（不做无意义拷贝）
 *  - 大图只保留约 64KB 对应字符数
 */
function main(): void {
  // 小图：原样返回
  assert(sliceBase64Head("AAAA", 65536) === "AAAA", "小于上限时应原样返回");
  assert(sliceBase64Head("", 65536) === "", "空串应原样返回");
  assert(sliceBase64Head("AAAA", 0) === "AAAA", "上限为 0 时不应崩（chars<=0 → 走长度判断）");

  // 大图：截断到 4 的倍数
  const big = "A".repeat(4 * 1024 * 1024); // 4M 字符，远超上限
  const head = sliceBase64Head(big, 65536);
  assert(head.length < big.length, "大图必须被截断（否则仍会读整图）");
  assert(head.length % 4 === 0, `截断后长度必须是 4 的倍数（否则解码会失败），实际 ${head.length}`);
  // 64KB 二进制 → ceil(65536/3)*4 = 87384 字符
  assert(head.length === 87384, `截断长度应等于 ceil(bytes/3)*4，实际 ${head.length}`);
  assert(head.length * 3 / 4 >= 65536, "截断后必须仍覆盖 64KB 头部（否则仍可能解析不出 SOF）");

  // 截断出来的前缀必须真的能解码（用 Buffer 模拟解码器的严格性）
  const decoded = Buffer.from(head, "base64");
  assert(decoded.length >= 65536, `截断前缀解码后应至少 64KB，实际 ${decoded.length}`);

  // 边界：长度恰好小于上限时不截断
  const exact = "A".repeat(87384);
  assert(sliceBase64Head(exact, 65536) === exact, "恰好等于上限时应原样返回");
  const oneMore = "A".repeat(87388);
  assert(sliceBase64Head(oneMore, 65536).length === 87384, "超过上限一个 quartet 时应截到上限");

  console.log("=== 图片头截断（#1503 回归）测试通过 ===");
}

main();
