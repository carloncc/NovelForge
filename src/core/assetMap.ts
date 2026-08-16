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
