import { buildThumbDataUrl, shouldReloadThumb, thumbTargetSize } from "../src/composables/useAssetThumbs";

/**
 * 缩略图狂闪根因回归：
 * - LRU 淘汰不得触发自动重读（否则淘汰→重读→再淘汰形成无限环路）；
 * - 显式作废（clearThumbCache）必须触发重读；
 * - 非显式重读受 2s 节流保护；
 * - 无 canvas 环境（Node/jsdom/老 webview）降采样必须优雅回退原图。
 */

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

// 1) LRU 淘汰绝不触发重读：即使距上次读取很久也要跳过
assert(
  shouldReloadThumb({ reason: "evicted", inView: true, hasValue: false, msSinceLastLoad: 10 * 60 * 1000 }) === false,
  "LRU 淘汰不得触发重读",
);

// 2) 显式作废必须触发重读（无视节流）
assert(
  shouldReloadThumb({ reason: "explicit", inView: true, hasValue: false, msSinceLastLoad: 0 }) === true,
  "显式作废必须触发重读",
);

// 已有值 / 不在视口 一律不重读
assert(
  shouldReloadThumb({ reason: "explicit", inView: true, hasValue: true, msSinceLastLoad: 0 }) === false,
  "已有值不应重读",
);
assert(
  shouldReloadThumb({ reason: "explicit", inView: false, hasValue: false, msSinceLastLoad: 0 }) === false,
  "不在视口不应重读",
);

// 3) 节流生效：进入视口 2s 内跳过，超过后允许
assert(
  shouldReloadThumb({ reason: "entered-view", inView: true, hasValue: false, msSinceLastLoad: 500 }) === false,
  "节流窗口内不应重读",
);
assert(
  shouldReloadThumb({ reason: "entered-view", inView: true, hasValue: false, msSinceLastLoad: 2500 }) === true,
  "超过节流窗口应允许重读",
);

// 目标尺寸纯函数：长边超限才缩，小图保持不变
const big = thumbTargetSize(1024, 512, 320);
assert(!!big && big.width === 320 && big.height === 160, `1024x512 应缩为 320x160，实际 ${JSON.stringify(big)}`);
assert(thumbTargetSize(200, 200, 320) === null, "长边不超限不应缩放");
assert(thumbTargetSize(0, 100, 320) === null, "非法尺寸应返回 null");

// 4) 无 canvas 环境（当前 Node 运行无 createImageBitmap/OffscreenCanvas/document）回退原图
const raw = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z8AAAAASUVORK5CYII=";
const out = await buildThumbDataUrl(raw, "/assets/x.png");
assert(out === raw, "无 canvas 环境应回退原图");

console.log("=== asset thumbnail LRU/downsample tests passed ===");
