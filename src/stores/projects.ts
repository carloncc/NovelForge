import { ref } from "vue";
import { configState } from "./config";
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

/** #1417：项目注册表上限（超出后最旧条目被挤出，文件不丢，可用新建项目对话框导航回来） */
export const PROJECT_LIST_LIMIT = 30;

/** #1417/#1511：最近一次因上限被挤出的条目（供列表尾部提示，不落盘）。
 *  必须用 ref：模块级 `export let` 是普通变量，Vue 的依赖收集不会追踪它——
 *  原写法即便在 upsertProject 里赋值，列表也不会重渲染，提示等于永远不出现。 */
export const lastEvictedProjects = ref<ProjectEntry[]>([]);

/** #1417：截断纯函数（可单测）：保留前 LIMIT 条，返回被挤出的旧条目供提示/恢复 */
export function truncateProjectList(list: ProjectEntry[]): { kept: ProjectEntry[]; evicted: ProjectEntry[] } {
  if (list.length <= PROJECT_LIST_LIMIT) return { kept: [...list], evicted: [] };
  return { kept: list.slice(0, PROJECT_LIST_LIMIT), evicted: list.slice(PROJECT_LIST_LIMIT) };
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
    // 最近使用优先：只更新 updatedAt 而不移动位置的话，列表顺序恒等于「首次登记顺序」，
    // 而 truncateProjectList 截的是前 30 条 —— 刚用过的项目会被后来的登记挤出列表，
    // 反而留下长期没动过的旧条目（文件还在，但用户得重新按目录找）。
    const at = list.indexOf(existing);
    if (at > 0) {
      list.splice(at, 1);
      list.unshift(existing);
    }
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
  // #1511：走 truncateProjectList 而不是内联 slice(0, 30)——上限常量与实现此前各写一份，
  // 改 PROJECT_LIST_LIMIT 不会同步；这里同时把被挤出的条目留痕，供 UI 提示而非静默消失。
  const { kept, evicted } = truncateProjectList(list);
  configState.projects = kept;
  if (evicted.length) lastEvictedProjects.value = evicted;
}

/** 仅移除注册记录，不删目录文件 */
export function removeProjectEntry(id: string): void {
  configState.projects = (configState.projects ?? []).filter((p) => p.id !== id);
}

/** 当前输出目录对应的项目（没有则返回 undefined） */

interface DirNovelIdentity {
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

type NovelImportDecision = "empty" | "same" | "different";

/** 导入保护（纯函数）：目录里已有别的小说快照时判 different，调用方弹窗分流。
 *  #1364：同文件名即判 same——titleSig 含 AI 分章后标题/用户改名，同书重导必然不一致，
 *  拿它判"不同小说"会把同名再导入推进"新建独立目录"陷阱。同名不同内容（换文件重名）的
 *  极端情况由调用方覆盖确认兜底，且管线指纹会按正文作废缓存，不会静默串味。 */
export function decideNovelImport(
  snapshot: DirNovelIdentity | null,
  incoming: { fileName: string; titleSig: string },
): NovelImportDecision {
  if (!snapshot) return "empty";
  if (snapshot.fileName === incoming.fileName) return "same";
  return "different";
}

/** 按小说文件名建议独立子目录名（去非法字符，回退时间戳） */
export function suggestProjectSubdirName(fileName: string): string {
  const base = displayNameOf(fileName, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim();
  return base || `novel-${Date.now().toString(36)}`;
}
