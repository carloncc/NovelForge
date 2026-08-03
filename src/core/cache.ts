import { tauri } from "../utils/tauri";

export function cacheDirFor(cacheRoot: string, section: string): string {
  return `${cacheRoot}/${section}`.replace(/\/+$/, "");
}

export async function cacheHit(dir: string, fileName: string): Promise<string | null> {
  const path = `${dir}/${fileName}`;
  try {
    if (await tauri.pathExists(path)) return path;
  } catch {
    /* ignore */
  }
  return null;
}

export function jsonKey(kind: string, key: string): string {
  return `${kind}_${key.replace(/[^\w\u4e00-\u9fa5-]/g, "_")}.json`;
}

export function slugify(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}
