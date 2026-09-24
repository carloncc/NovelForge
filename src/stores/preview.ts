import { tauri } from "../utils/tauri";

/**
 * 预览服务器共享持有者（#1323）：服务器是进程级单例（固定端口，start 先杀旧实例），
 * 预览页与图片小说页各自管理就会互踩——切页回来「预览已启动」标签是假的，服务已被换根或停掉。
 * 收敛规则：
 * - 启动=接管（Rust start 内部接管旧实例：先校验新根，失败不碰旧实例；成功才停旧起新，绑定失败回滚），持有者记名；
 * - unmount/停止只停自己持有的（releasePreview 非持有者直接返回 false，不碰别人的服务）；
 * - 状态（url/running）仍由各页自己的 store 管，本模块只管"谁持有服务器"。
 * #1429：TS 层不再前置 stop（此前无条件 stop 架空了 Rust 校验期保旧实例的承诺）；
 *   claim 前先校验新根有效，失败直接抛、持有者与当前根保持不变（旧预览保持可用）；
 *   start 失败同样不改持有者/当前根（Rust 侧负责回滚旧实例）。
 * #1430：claim/release 收敛进同一串行队列，晚到的 stop 杀不掉刚启动的服务；
 *   release 的 owner 复查放到 stop 完成后执行。
 */

export type PreviewOwner = "main" | "imageStory";

let owner: PreviewOwner | null = null;
/** #1429：当前持有者对应的根目录（成功 claim 时记录，release 成功时清空，失败保持不变用于回滚语义） */
let currentRoot: string | null = null;

/** claim/release 串行队列（#1430）：按调用顺序执行，前一个 settled 后才跑下一个 */
let previewQueue: Promise<void> = Promise.resolve();

function enqueuePreview<T>(fn: () => Promise<T>): Promise<T> {
  const run = previewQueue.then(fn, fn);
  previewQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 当前持有者（无则 null） */
export function previewOwner(): PreviewOwner | null {
  return owner;
}

/** 当前持有者对应的根目录（无则 null） */
export function previewRoot(): string | null {
  return currentRoot;
}

/** 纯函数：预览根是否有效（非空；深层存在性由 pathExists 异步校验） */
export function isValidPreviewRoot(root: string): boolean {
  return (root ?? "").trim().length > 0;
}

/** 纯函数：release 在 stop 完成后是否应清空持有名（期间被新 claim 接管则不清） */
export function shouldClearOwnerOnRelease(ownerAtStart: PreviewOwner | null, ownerAtEnd: PreviewOwner | null, requester: PreviewOwner): boolean {
  return ownerAtStart === requester && ownerAtEnd === requester;
}

/** 单测复位钩子：清空持有者/当前根/队列（生产代码不调用） */
export function __resetPreviewStateForTests(): void {
  owner = null;
  currentRoot = null;
  previewQueue = Promise.resolve();
}

/** 单测预置钩子：设置持有者与当前根（生产代码不调用） */
export function __setPreviewStateForTests(next: PreviewOwner | null, root: string | null): void {
  owner = next;
  currentRoot = root;
}

/** 启动并接管：先校验新根有效再起新服务；成功记名并返回 url，失败持有者与当前根不变并抛出 */
export async function claimPreview(next: PreviewOwner, root: string): Promise<string> {
  return enqueuePreview(async () => {
    const trimmed = (root ?? "").trim();
    if (!isValidPreviewRoot(trimmed)) {
      throw new Error("预览目录无效：目录为空，旧预览保持可用");
    }
    // #1429：校验期不碰旧实例——新根不可访问时直接失败，旧预览保持可用
    let exists = false;
    try {
      exists = await tauri.pathExists(trimmed);
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new Error(`预览目录无效：${trimmed} 不存在或不可访问，旧预览保持可用`);
    }
    // 不再前置 stop：Rust start 内部先校验、成功才停旧起新、失败回滚旧根
    const res = await tauri.startPreviewServer(trimmed);
    owner = next;
    currentRoot = trimmed;
    return res.url;
  });
}

/** 仅持有者可停服：成功清名返回 true；非持有者返回 false（不碰别人的服务）。
 *  停服失败时抛出且保留持有名（服务可能还活着），由调用方记日志。 */
export async function releasePreview(next: PreviewOwner): Promise<boolean> {
  return enqueuePreview(async () => {
    const ownerAtStart = owner;
    if (ownerAtStart !== next) return false;
    await tauri.stopPreviewServer();
    // #1430：复查放到 stop 完成后（串行队列下正常仍相等；防御未来直接调用 tauri 造成的交错）
    if (!shouldClearOwnerOnRelease(ownerAtStart, owner, next)) return false;
    owner = null;
    currentRoot = null;
    return true;
  });
}
