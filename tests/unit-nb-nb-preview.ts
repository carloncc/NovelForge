/**
 * 预览接管回归（#1429 / #1430，白名单 src/stores/preview.ts）：
 * - #1429：claim 前校验新根有效，失败不改持有者与当前根（旧预览保持可用）；start 失败同样回滚语义；
 * - #1430：claim/release 同一串行队列，晚到的 stop 杀不掉刚启动的服务；release 复查谓词放到 stop 完成后。
 */
import {
  claimPreview,
  releasePreview,
  previewOwner,
  previewRoot,
  isValidPreviewRoot,
  shouldClearOwnerOnRelease,
  __resetPreviewStateForTests,
  __setPreviewStateForTests,
} from "../src/stores/preview";
import { tauri } from "../src/utils/tauri";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const orig = {
  pathExists: tauri.pathExists,
  startPreviewServer: tauri.startPreviewServer,
  stopPreviewServer: tauri.stopPreviewServer,
};

function stubTransport(opts: {
  exists?: (p: string) => boolean;
  start?: (root: string) => Promise<{ url: string; port: number }>;
  stop?: () => Promise<void>;
}): void {
  const exists = opts.exists ?? (() => true);
  (tauri as unknown as Record<string, unknown>).pathExists = async (p: string) => exists(p);
  (tauri as unknown as Record<string, unknown>).startPreviewServer = async (root: string) => {
    if (opts.start) return opts.start(root);
    return { url: `preview://${root}`, port: 1 };
  };
  (tauri as unknown as Record<string, unknown>).stopPreviewServer = async () => {
    if (opts.stop) return opts.stop();
  };
}

function restore(): void {
  (tauri as unknown as Record<string, unknown>).pathExists = orig.pathExists;
  (tauri as unknown as Record<string, unknown>).startPreviewServer = orig.startPreviewServer;
  (tauri as unknown as Record<string, unknown>).stopPreviewServer = orig.stopPreviewServer;
}

async function main(): Promise<void> {
  // 纯函数：根有效性
  assert(isValidPreviewRoot("") === false, "空根应无效");
  assert(isValidPreviewRoot("   ") === false, "空白根应无效");
  assert(isValidPreviewRoot("/proj/game") === true, "非空根应有效");

  // 纯函数：release 复查谓词
  assert(shouldClearOwnerOnRelease("main", "main", "main") === true, "同持有者应清空");
  assert(shouldClearOwnerOnRelease("main", "imageStory", "main") === false, "期间被接管不清名");
  assert(shouldClearOwnerOnRelease("main", "main", "imageStory") === false, "非持有者请求不清名");
  assert(shouldClearOwnerOnRelease(null, null, "main") === false, "无持有者不清名");

  // #1429：空根直接拒绝，持有者与当前根不变
  __resetPreviewStateForTests();
  __setPreviewStateForTests("main", "/old/game");
  stubTransport({ exists: () => true });
  let threw = false;
  try {
    await claimPreview("imageStory", "   ");
  } catch {
    threw = true;
  }
  assert(threw, "空根 claim 应抛出");
  assert(previewOwner() === "main", "空根失败后持有者应保持 main");
  assert(previewRoot() === "/old/game", "空根失败后当前根应保持旧根");

  // #1429：新根不存在时拒绝且不碰旧实例（不调用 start）
  __resetPreviewStateForTests();
  __setPreviewStateForTests("main", "/old/game");
  let startCalls = 0;
  stubTransport({
    exists: () => false,
    start: async (root) => {
      startCalls++;
      return { url: `preview://${root}`, port: 1 };
    },
  });
  threw = false;
  try {
    await claimPreview("imageStory", "/deleted/game");
  } catch (e) {
    threw = true;
    assert(String((e as Error).message).includes("旧预览保持可用"), "失败信息应承诺旧预览可用");
  }
  assert(threw, "无效根 claim 应抛出");
  assert(startCalls === 0, "无效根不得调用 start（校验期不碰旧实例）");
  assert(previewOwner() === "main", "无效根失败后持有者不变");
  assert(previewRoot() === "/old/game", "无效根失败后当前根不变");

  // #1429：start 失败时回滚语义（持有者与当前根不变）
  __resetPreviewStateForTests();
  __setPreviewStateForTests("main", "/old/game");
  stubTransport({
    exists: () => true,
    start: async () => {
      throw new Error("bind failed");
    },
  });
  threw = false;
  try {
    await claimPreview("imageStory", "/new/game");
  } catch {
    threw = true;
  }
  assert(threw, "start 失败应抛出");
  assert(previewOwner() === "main", "start 失败后持有者应回滚为旧持有者");
  assert(previewRoot() === "/old/game", "start 失败后当前根应回滚为旧根");

  // 成功路径：记名并记录当前根
  __resetPreviewStateForTests();
  stubTransport({ exists: () => true });
  const url = await claimPreview("imageStory", "/new/game");
  assert(url.includes("/new/game"), "成功应返回新根 url");
  assert(previewOwner() === "imageStory", "成功后持有者应为新持有者");
  assert(previewRoot() === "/new/game", "成功后应记录当前根");

  // #1430：非持有者 release 返回 false 且不调用 stop
  __resetPreviewStateForTests();
  __setPreviewStateForTests("imageStory", "/new/game");
  let stopCalls = 0;
  stubTransport({
    exists: () => true,
    stop: async () => {
      stopCalls++;
    },
  });
  const notOwned = await releasePreview("main");
  assert(notOwned === false, "非持有者 release 应返回 false");
  assert(stopCalls === 0, "非持有者 release 不得调用 stop");
  assert(previewOwner() === "imageStory", "非持有者 release 不得改名");

  // #1430：串行化——旧 release 的慢 stop 先落盘，新 claim 后执行，晚到的 stop 杀不掉新服务
  __resetPreviewStateForTests();
  __setPreviewStateForTests("main", "/old/game");
  const order: string[] = [];
  stubTransport({
    exists: () => true,
    start: async (root) => {
      order.push(`start:${root}`);
      return { url: `preview://${root}`, port: 1 };
    },
    stop: async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("stop");
    },
  });
  const [rel, claimUrl] = await Promise.all([releasePreview("main"), claimPreview("imageStory", "/new/game")]);
  assert(rel === true, "持有者 release 应成功");
  assert(claimUrl.includes("/new/game"), "排队后的 claim 应成功");
  assert(order.join("|") === "stop|start:/new/game", `串行顺序应为 stop→start，实际 ${order.join("|")}`);
  assert(previewOwner() === "imageStory", "最终持有者应为后到的 claim");
  assert(previewRoot() === "/new/game", "最终当前根应为新根");

  console.log("=== 预览接管回归（#1429/#1430）测试通过 ===");
}

try {
  await main();
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
} finally {
  restore();
}
