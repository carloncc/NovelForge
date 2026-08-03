import { tauri } from "./tauri";

export async function resolveTemplateDir(): Promise<string> {
  const res = await tauri.resourceDir();
  const cand = `${res}/templates/webgal`;
  if (await tauri.pathExists(`${cand}/index.html`)) {
    return cand;
  }
  throw new Error(`未找到 WebGAL 引擎模板（${cand}）`);
}
