import { tauri } from "../src/utils/tauri";

const timers: Array<() => void> = [];
(globalThis as unknown as { window: { setTimeout: (fn: () => void) => number; clearTimeout: () => void } }).window = {
  setTimeout(fn) {
    timers.push(fn);
    return timers.length;
  },
  clearTimeout() {},
};

const originalRead = tauri.readFileBase64;
let reads = 0;
tauri.readFileBase64 = async () => {
  reads++;
  throw new Error("missing");
};

try {
  const { clearThumbCache, loadAssetDataUrl } = await import("../src/composables/useAssetThumbs");
  clearThumbCache();
  loadAssetDataUrl("/missing.png");
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    timers.shift()?.();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (reads > 4) throw new Error(`permanently missing thumbnails must stop retrying, got ${reads} reads`);
  console.log("=== asset thumbnail retry tests passed ===");
} finally {
  tauri.readFileBase64 = originalRead;
}
