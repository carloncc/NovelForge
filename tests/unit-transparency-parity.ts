/**
 * #1543：把 #1495 的跨语言等价钉在 TS 侧。
 *
 * 「这张素材是否已自带透明通道」两端各有一份判据：
 *   - 桌面端 cutout.rs:  transparent * 100 > total * 5        （整数交叉相乘）
 *   - 网页端 webRuntime:  low / Math.max(1, data.length / 4) > 0.05  （浮点）
 * #1495 已把桌面端从「transparent * 100 / total > 5」（整数除法先截断，实际阈值变成 >=6%）
 * 改成交叉相乘，理由就是与网页端的浮点口径对齐。
 *
 * Rust 侧有 transparency_threshold_matches_web_exactly 钉边界，但网页端这边没有任何等价物：
 * 只靠注释互相声明一致，哪天一边被改回去，另一边不会有人发现。本文件在 TS 侧对拍两种写法。
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 桌面端：cutout.rs 的写法（整数交叉相乘） */
function rustWay(low: number, total: number): boolean {
  const t = Math.max(total, 1);
  return low * 100 > t * 5;
}

/** 网页端：webRuntime.webHasTransparency 的写法（浮点） */
function webWay(low: number, total: number): boolean {
  return low / Math.max(1, total) > 0.05;
}

/**
 * 旧版桌面端写法：Rust 的 / 是**整数除法**，先截断再比较，阈值实际变成 >=6%。
 * 注意这里必须用 Math.floor 还原整数除法——我第一版直接写 (low * 100) / t 就漏了，
 * 结果在 6% 这个点上两端本来就一致（都是 true），断言便误报成 bug。
 */
function oldRustWay(low: number, total: number): boolean {
  const t = Math.max(total, 1);
  return Math.floor((low * 100) / t) > 5;
}

function main(): void {
  // ① 两种写法必须在全量扫描下完全等价
  let mismatches = 0;
  for (let total = 0; total <= 4000; total++) {
    const step = total >= 200 ? 1 : Math.max(1, Math.floor(total / 40));
    for (let low = 0; low <= total; low += step) {
      if (rustWay(low, total) !== webWay(low, total)) {
        if (mismatches < 3) console.log("  !! 不一致 low=" + low + " total=" + total);
        mismatches++;
      }
    }
  }
  assert(mismatches === 0, "整数交叉相乘与浮点写法不等价：" + mismatches + " 处（#1543）");

  // ② 恰好 5% 必须判「未透明」（两端现在都是精确的 >5%）
  assert(rustWay(5, 100) === false, "恰好 5% 应判未透明（#1543）");
  assert(webWay(5, 100) === false, "恰好 5% 应判未透明（#1543）");
  assert(rustWay(6, 100) === true, "6% 应判已透明（#1543）");
  assert(webWay(6, 100) === true, "6% 应判已透明（#1543）");

  // ③ 这正是 #1495 的核心：旧写法会把 5%~5.99% 整段判反（恰好 6% 两端反而一致）
  for (const [low, total] of [[11, 200], [13, 240], [57, 1000], [299, 5000]] as [number, number][]) {
    assert(oldRustWay(low, total) === false, "旧整数除法写法在 " + low + "/" + total + " 处应判错（#1495）");
    assert(webWay(low, total) === true, "网页端在同一处应判对（#1495）");
  }
  // 恰好 6% 处两端一致——旧写法的第一个分歧点其实在 5%~5.99%
  assert(oldRustWay(6, 100) === webWay(6, 100), "恰好 6% 两端应一致");

  // ④ max(1) 兜底：真正会发生的只有 total=0（此时 low 必为 0），两端都判未透明。
  //    low>total 这种输入实际不可能出现（low 是 total 个像素里数出来的），
  //    所以这里只钉「两端一致」这个性质，不去规定具体取值——我先前写死成 false 是错的。
  assert(rustWay(0, 0) === false && webWay(0, 0) === false, "0 像素不得判已透明（#1543）");
  assert(rustWay(1, 0) === webWay(1, 0), "max(1) 兜底两端必须一致（#1543）");
  for (const [low, total] of [[0, 0], [1, 0], [0, 1]] as [number, number][])
    assert(rustWay(low, total) === webWay(low, total),
      "退化输入 low=" + low + " total=" + total + " 两端不一致（#1543）");

  console.log("=== 透明通道阈值跨语言等价测试通过（#1543：整数交叉相乘 ≡ 浮点 >5%）===");
}

main();

// 本文件没有 import/export，tsc 会把它当成**全局脚本**：里面的 main / assert 会直接进全局作用域，
// 与其他同样没有 import/export 的单测文件（unit-audit-u2-budget-clamp.ts 等）重名，
// 报 TS2393 重复实现，并把对方文件连带打挂（TS7006 隐式 any）。export {} 把本文件变成模块即可隔离。
export {};
