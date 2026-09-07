import { configState } from "./config";
import { projectState } from "./project";
import { tauri } from "../utils/tauri";
import { stateFile } from "../utils/persist";
import type { ProjectEntry } from "./configMigration";

function makeProjectId(): string {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function displayNameOf(fileName: string, fallback: string): string {
  const base = (fileName || "").split(/[\\/]/).pop() || "";
  return base.replace(/\.[^.]+$/, "").trim() || fallback;
}

/** 登记/刷新项目（输出目录即项目键）。 novel 缺省时沿用快照/旧记录。 */
export function upsertProject(outputDir: string, novel?: { fileName: string; title: string }): void {
  const dir = (outputDir || "").trim();
  if (!dir) return;
  const list = configState.projects ?? [];
  const fileName = novel?.fileName ?? "";
  const title = novel?.title ?? "";
  const existing = list.find((p) => p.outputDir === dir);
  if (existing) {
    if (fileName) {
      existing.novelFileName = fileName;
      existing.name = displayNameOf(fileName, existing.name);
    }
    if (title) existing.novelTitle = title;
    existing.updatedAt = new Date().toISOString();
  } else {
    list.unshift({
      id: makeProjectId(),
      name: displayNameOf(fileName, dir),
      outputDir: dir,
      novelFileName: fileName,
      novelTitle: title,
      updatedAt: new Date().toISOString(),
    });
  }
  configState.projects = list.slice(0, 30);
}

/** 仅移除注册记录，不删目录文件 */
export function removeProjectEntry(id: string): void {
  configState.projects = (configState.projects ?? []).filter((p) => p.id !== id);
}

/** 当前输出目录对应的项目（没有则返回 undefined） */
export function activeProject(): ProjectEntry | undefined {
  const dir = projectState.outputDir;
  if (!dir) return undefined;
  return (configState.projects ?? []).find((p) => p.outputDir === dir);
}

export interface DirNovelIdentity {
  fileName: string;
  /** 章节标题签名（标题用 | 连接），用于区分同名不同内容 */
  titleSig: string;
}

/** 读目录快照里的小说身份（无快照/无小说返回 null）。轻量：只读 JSON，不做全量恢复。 */
export async function readDirNovelIdentity(outputDir: string): Promise<DirNovelIdentity | null> {
  try {
    const { text } = await tauri.readTextFile(stateFile(outputDir));
    const parsed = JSON.parse(text) as { novel?: { fileName?: string; chapters?: { title?: string }[] } };
    if (!parsed?.novel || typeof parsed.novel.fileName !== "string") return null;
    const titles = Array.isArray(parsed.novel.chapters)
      ? parsed.novel.chapters.map((c) => c?.title ?? "").join("|")
      : "";
    return { fileName: parsed.novel.fileName, titleSig: titles };
  } catch {
    return null;
  }
}

export type NovelImportDecision = "empty" | "same" | "different";

/** 导入保护（纯函数）：目录里已有别的小说快照时判 different，调用方弹窗分流 */
export function decideNovelImport(
  snapshot: DirNovelIdentity | null,
  incoming: { fileName: string; titleSig: string },
): NovelImportDecision {
  if (!snapshot) return "empty";
  if (snapshot.fileName === incoming.fileName && snapshot.titleSig === incoming.titleSig) return "same";
  return "different";
}

/** 按小说文件名建议独立子目录名（去非法字符，回退时间戳） */
export function suggestProjectSubdirName(fileName: string): string {
  const base = displayNameOf(fileName, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim();
  return base || `novel-${Date.now().toString(36)}`;
}
