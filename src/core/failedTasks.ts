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
 * 只按 id 匹配会把「同名不同用途」的失败/成功互相抵消。
 * #1311：类别判定只读 message 首段中文前缀，文案改动即错位——此处仅做尽力归类（默认 figure），
 * 去重键错位的最坏后果是多保留一条失败项（宁可多试一次，不静默丢失败）。 */
export function failedTaskIdentity(f: FailedTask): string {
  if (f.kind !== "image") return `${f.kind}:${f.id}`;
  const usage = ((f.message ?? "").split("：")[0] || "").trim();
  let cat = "figure";
  if (usage.startsWith("背景")) cat = "bg";
  else if (usage.startsWith("CG")) cat = "cg";
  else if (usage.startsWith("物品")) cat = "item";
  return `image:${f.id}:${cat}`;
}

/**
 * 读失败项清单。
 *
 * 损坏即 fail-closed（与 assetMap.ts:37-49 同口径）：解析失败先把原文件隔离成
 * `failed.corrupt-<ts>.json`，隔离**写不进去就抛错**——绝不返回空表。
 * 旧实现把解析/读取异常一律吞成 []，而 mutateFailedTasks 会拿这个空表当基底整份覆写：
 * 半截 JSON（上次写入被中断或用户手改）→ 下一次任一失败触发写入 → 此前记录的几十条失败
 * （哪些图/哪句配音失败）无声消失，用户失去逐条重试入口。
 * 注意：文件不存在仍是合法的空表（首次运行），只有"文件在但读不出"才算损坏。
 */
export async function readFailedTasks(outputDir: string): Promise<FailedTask[]> {
  const file = failedTasksFile(outputDir);
  if (!(await tauri.pathExists(file))) return [];
  let text: string;
  try {
    ({ text } = await tauri.readTextFile(file));
  } catch (e) {
    // 读不出来（权限/IO）同样不能当空表：宁可让本次写入失败（调用方只记 warn），
    // 也不能把唯一一份失败清单覆盖成"本次新增的那一条"。
    throw new Error(`failed.json 读取失败，已中止本次失败项写入以免覆盖原文件：${String(e).slice(0, 160)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    const backup = `${file}.corrupt-${Date.now()}.json`;
    // 备份失败必须抛出（旧实现 .catch(()=>{}) 后照常返回空表，唯一副本随即被覆盖）
    await tauri.writeTextFile(backup, text);
    logger.warn("failed-tasks", `failed.json 解析失败，已隔离为 ${backup} 并中止本次写入（请人工检查后删除该文件以重建）`, {
      outputDir,
      error: String(e).slice(0, 140),
    });
    throw new Error(`failed.json 已损坏（已隔离为 ${backup}），本次不覆盖它：请检查该文件后重试`);
  }
  if (!Array.isArray(parsed)) {
    const backup = `${file}.corrupt-${Date.now()}.json`;
    await tauri.writeTextFile(backup, text);
    logger.warn("failed-tasks", `failed.json 结构不是数组，已隔离为 ${backup} 并中止本次写入`, { outputDir });
    throw new Error(`failed.json 结构异常（已隔离为 ${backup}），本次不覆盖它`);
  }
  return parsed.filter(
    (f): f is FailedTask =>
      !!f && typeof f === "object" && typeof (f as FailedTask).id === "string" && typeof (f as FailedTask).step === "string",
  ).map((f) => (
    // #1311：手改/损坏的 failed.json 可能缺 message（identity 内 .split 即崩整个读取）。
    // 缺失按空串补齐（归类默认 figure），损坏条目仍可见、可重试，不整盘作废。
    typeof f.message === "string" ? f : { ...f, message: "" }
  ));
}

/** 串行化读改写：mutate 返回新列表。
 *  读取（含损坏隔离）失败时**抛出**且不写盘：旧实现把解析失败吞成空表再整份覆写，
 *  等于用「本次新增的那一条」抹掉全部历史失败项。调用方（管线/素材页）只记 warn，不阻断主流程。 */
export async function mutateFailedTasks(
  outputDir: string,
  mutate: (list: FailedTask[]) => FailedTask[],
): Promise<FailedTask[]> {
  const file = failedTasksFile(outputDir);
  const run = (async () => {
    const prev = writeChains.get(file);
    if (prev) await prev.catch(() => undefined);
    // readFailedTasks 在文件损坏时会抛（并已把原文件隔离备份）：这里不吞，直接让本次写入失败
    const list = await readFailedTasks(outputDir);
    const next = mutate(list);
    await tauri.writeTextFile(file, JSON.stringify(next, null, 2));
    return next;
  })();
  writeChains.set(
    file,
    run.catch((e) => {
      logger.warn("failed-tasks", "失败项落盘失败（不阻断主流程）", { error: String(e).slice(0, 200) });
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

/** 展示用失败列表：磁盘（failed.json）为事实来源，内存本次运行结果补充；按身份去重。
 *  图像 bg/cg 共用 scene.id——只按 id 去重会互相抵消（用户实测「重试成功仍显示失败」的根因之一）。 */
export function visibleFailedTasks(persisted: FailedTask[], current: FailedTask[]): FailedTask[] {
  const seen = new Set(persisted.map((f) => failedTaskIdentity(f)));
  return [...persisted, ...current.filter((f) => !seen.has(failedTaskIdentity(f)))];
}
