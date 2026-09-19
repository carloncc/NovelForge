import type { FailedTask } from "./types";
import { tauri } from "../utils/tauri";
import { cleanPath } from "../utils/path";
import { log as logger } from "../utils/logger";

/** 统一的失败项文件通道：管线、素材页、失败重试共用。
 * 串行化读-改-写，避免并发写互相覆盖（旧实现两处并发 persist 会丢数据）。 */

const writeChains = new Map<string, Promise<unknown>>();

export function failedTasksFile(outputDir: string): string {
  return cleanPath(`${outputDir}/.novel2vn/failed.json`);
}

/** 失败项身份：图像按用途类别区分（bg/cg/figure/item）——背景与 CG 共用 scene.id，
 * 只按 id 匹配会把「同名不同用途」的失败/成功互相抵消。 */
export function failedTaskIdentity(f: FailedTask): string {
  if (f.kind !== "image") return `${f.kind}:${f.id}`;
  const usage = (f.message.split("：")[0] || "").trim();
  let cat = "figure";
  if (usage.startsWith("背景")) cat = "bg";
  else if (usage.startsWith("CG")) cat = "cg";
  else if (usage.startsWith("物品")) cat = "item";
  return `image:${f.id}:${cat}`;
}

export async function readFailedTasks(outputDir: string): Promise<FailedTask[]> {
  try {
    const file = failedTasksFile(outputDir);
    if (!(await tauri.pathExists(file))) return [];
    const { text } = await tauri.readTextFile(file);
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FailedTask =>
        !!f && typeof f === "object" && typeof (f as FailedTask).id === "string" && typeof (f as FailedTask).step === "string",
    );
  } catch {
    return [];
  }
}

/** 串行化读改写：mutate 返回新列表；写入失败不抛出（失败列表落盘不阻断主流程） */
export async function mutateFailedTasks(
  outputDir: string,
  mutate: (list: FailedTask[]) => FailedTask[],
): Promise<FailedTask[]> {
  const file = failedTasksFile(outputDir);
  const run = (async () => {
    const prev = writeChains.get(file);
    if (prev) await prev.catch(() => undefined);
    const list = await readFailedTasks(outputDir);
    const next = mutate(list);
    await tauri.writeTextFile(file, JSON.stringify(next, null, 2));
    return next;
  })();
  writeChains.set(
    file,
    run.catch((e) => {
      logger.warn("failed-tasks", "失败项落盘失败（不阻断主流程）", { error: String(e).slice(0, 160) });
    }),
  );
  return run;
}

/** 合并去重（同身份保留最新一条）：管线与素材页共用 */
export function mergeFailedTasks(list: FailedTask[], incoming: FailedTask[]): FailedTask[] {
  const map = new Map<string, FailedTask>();
  for (const f of list) map.set(failedTaskIdentity(f), f);
  for (const f of incoming) map.set(failedTaskIdentity(f), f);
  return [...map.values()];
}
