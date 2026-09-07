import type { AssetMap } from "./types";
import { tauri } from "../utils/tauri";

const updateChains = new Map<string, Promise<void>>();

export function emptyAssetMap(): AssetMap {
  return { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
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
  };
}

export async function readAssetMap(outputDir: string): Promise<AssetMap> {
  const path = `${outputDir}/.novel2vn/assets.json`;
  if (!(await tauri.pathExists(path))) return emptyAssetMap();
  const { text } = await tauri.readTextFile(path);
  return parseAssetMap(JSON.parse(text));
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

export function assetBackupFileName(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `assets.backup-${stamp}.json`;
}

/** 备份当前 assets.json（最多保留 keep 份，旧的自动删）。无映射文件时返回 null。 */
export async function backupAssetMap(outputDir: string, keep = 3): Promise<string | null> {
  const dir = `${outputDir}/.novel2vn`;
  try {
    const { text } = await tauri.readTextFile(`${dir}/assets.json`);
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
      /* 旧备份清理失败不影响 */
    }
    return name;
  } catch {
    return null;
  }
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
