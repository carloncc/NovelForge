import { tauri } from "../utils/tauri";

/**
 * 预览服务器共享持有者（#1323）：服务器是进程级单例（固定端口，start 先杀旧实例），
 * 预览页与图片小说页各自管理就会互踩——切页回来「预览已启动」标签是假的，服务已被换根或停掉。
 * 收敛规则：
 * - 启动=接管（先停旧的再起新的），持有者记名；
 * - unmount/停止只停自己持有的（releasePreview 非持有者直接返回 false，不碰别人的服务）；
 * - 状态（url/running）仍由各页自己的 store 管，本模块只管"谁持有服务器"。
 */
export type PreviewOwner = "main" | "imageStory";

let owner: PreviewOwner | null = null;

/** 当前持有者（无则 null） */
export function previewOwner(): PreviewOwner | null {
  return owner;
}

/** 启动并接管：先停旧服务再起新服务；成功记名并返回 url，失败持有者不变并抛出 */
export async function claimPreview(next: PreviewOwner, root: string): Promise<string> {
  await tauri.stopPreviewServer().catch(() => undefined);
  const res = await tauri.startPreviewServer(root);
  owner = next;
  return res.url;
}

/** 仅持有者可停服：成功清名返回 true；非持有者返回 false（不碰别人的服务）。
 *  停服失败时抛出且保留持有名（服务可能还活着），由调用方记日志。 */
export async function releasePreview(next: PreviewOwner): Promise<boolean> {
  if (owner !== next) return false;
  await tauri.stopPreviewServer();
  owner = null;
  return true;
}
