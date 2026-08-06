import { tauri } from "../utils/tauri";
import { cleanPath, safeFilename } from "../utils/path";

export function cacheDirFor(cacheRoot: string, section: string): string {
  return cleanPath(`${cacheRoot}/${section}`);
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
  return `${kind}_${safeFilename(key, 100)}.json`;
}

export function slugify(s: string): string {
  return safeFilename(s, 60);
}
