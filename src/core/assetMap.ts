import type { AssetMap } from "./types";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";

const updateChains = new Map<string, Promise<void>>();

export function emptyAssetMap(): AssetMap {
  return { bg: {}, cg: {}, figure: {}, item: {}, vocal: {}, shot: {} };
}

function stringMap(input: unknown, field: keyof AssetMap): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`assets.json field ${field} must be an object`);
  const entries = Object.entries(input);
  if (entries.some(([, path]) => typeof path !== "string")) throw new Error(`assets.json field ${field} contains a non-string path`);
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseAssetMap(input: unknown): AssetMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("assets.json must contain an object");
  const record = input as Record<string, unknown>;
  return {
    bg: stringMap(record.bg, "bg"),
    cg: stringMap(record.cg, "cg"),
    figure: stringMap(record.figure, "figure"),
    item: stringMap(record.item, "item"),
    vocal: stringMap(record.vocal, "vocal"),
    // 图片小说分镜（可选字段）：旧 assets.json 没有该键时按空处理
    shot: stringMap(record.shot, "shot"),
  };
}

export async function readAssetMap(outputDir: string): Promise<AssetMap> {
  const path = `${outputDir}/.novel2vn/assets.json`;
  if (!(await tauri.pathExists(path))) return emptyAssetMap();
  const { text } = await tauri.readTextFile(path);
  try {
    return parseAssetMap(JSON.parse(text));
  } catch (e) {
    // 损坏的 assets.json 此前让整条管线不可运行（JSON.parse 直接抛）。隔离损坏文件后从空映射继续，
    // 原文件保留为 .corrupt-<ts>.json 供人工找回；调用方的备份/补全流程可继续工作
    const backup = `${path}.corrupt-${Date.now()}.json`;
    // #1516：隔离失败必须抛出。旧实现 .catch(() => {}) 后照常返回空映射，
    // 调用方随后 updateAssetMap 会直接覆盖这个损坏文件——唯一的内容副本没了，
    // 而日志还宣称「已隔离」。宁可让管线停下，用户仍有机会手动抢救。
    await tauri.writeTextFile(backup, text);
    log.warn("assetMap", `assets.json 解析失败，已隔离为 ${backup} 并从空映射继续：${String(e).slice(0, 140)}`, { outputDir });
    return emptyAssetMap();
  }
}

export function updateAssetMap(outputDir: string, mutate: (assets: AssetMap) => void): Promise<void> {
  const path = `${outputDir}/.novel2vn/assets.json`;
  const previous = updateChains.get(path) ?? Promise.resolve();
  const writeUpdate = async (): Promise<void> => {
    const assets = await readAssetMap(outputDir);
    mutate(assets);
    await tauri.writeTextFile(path, JSON.stringify(assets, null, 2));
  };
  const current = previous.then(writeUpdate, writeUpdate);
  updateChains.set(path, current);
  return current.finally(() => {
    if (updateChains.get(path) === current) updateChains.delete(path);
  });
}

/* ---------- 映射备份与恢复：剪枝等破坏性写之前先备份，误删可一键回来 ---------- */

const ASSET_BACKUP_RE = /^assets\.backup-.*\.json$/;

function assetBackupFileName(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `assets.backup-${stamp}.json`;
}

/**
 * 备份当前 assets.json（最多保留 keep 份，旧的自动删）。
 *
 * #1516：返回值语义收紧——null **只**表示「本来就没有 assets.json」（首次运行，
 * 不存在任何需要保护的内容）；「文件在但读不出」或「备份写不进」一律抛出。
 * 旧实现把两者一并吞成 null，调用方无法区分，于是照常执行剪枝/覆盖：
 * 唯一一份映射被覆盖后无从回滚，而日志还在宣称「误删可恢复」。
 */
export async function backupAssetMap(outputDir: string, keep = 3): Promise<string | null> {
  const dir = `${outputDir}/.novel2vn`;
  const src = `${dir}/assets.json`;
  if (!(await tauri.pathExists(src))) return null;
  const { text } = await tauri.readTextFile(src);
  const name = assetBackupFileName();
  await tauri.writeTextFile(`${dir}/${name}`, text);
  try {
    const entries = await tauri.listDir(dir);
    const backups = entries
      .filter((e) => !e.isDir && ASSET_BACKUP_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    while (backups.length > keep) {
      const old = backups.shift()!;
      await tauri.removePath(`${dir}/${old}`).catch(() => {});
    }
  } catch {
    /* 旧备份清理失败不影响：备份文件已落盘 */
  }
  return name;
}

/** 列出映射备份（从新到旧）。 */
export async function listAssetBackups(outputDir: string): Promise<string[]> {
  try {
    const entries = await tauri.listDir(`${outputDir}/.novel2vn`);
    return entries
      .filter((e) => !e.isDir && ASSET_BACKUP_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 从备份恢复 assets.json（先校验格式，坏备份拒绝写入）。 */
export async function restoreAssetBackup(outputDir: string, name: string): Promise<void> {
  if (!ASSET_BACKUP_RE.test(name)) throw new Error("非法备份文件名");
  const dir = `${outputDir}/.novel2vn`;
  const { text } = await tauri.readTextFile(`${dir}/${name}`);
  parseAssetMap(JSON.parse(text));
  await tauri.writeTextFile(`${dir}/assets.json`, text);
}
