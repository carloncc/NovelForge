import { reactive, watch } from "vue";
import type {
  ChapterScript,
  CostStats,
  GenerationOptions,
  MaterialAsset,
  NovelDoc,
  PipelineEvent,
  PipelineResult,
  ProjectMeta,
  ProjectVisualBible,
} from "../core/types";
import { saveProjectState, restoreProjectState, readWorkingCards } from "../utils/persist";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";
import { clearThumbCache } from "../composables/useAssetThumbs";
import { activeConfig } from "./config";
import { STEP_TO_STAGE, DEFAULT_BACKGROUND_REUSE, type StageKey } from "../core/types";
import { parseChapterScript } from "../core/dataValidation";
import { isScriptPartFileName } from "../core/cache";
import { runStatusSetFailed } from "./runStatus";

interface ProjectState {
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult: PipelineResult | null;
  visualBible: ProjectVisualBible | null;
  visualBibleWarnings: string[];
  saveError: string | null;
  logs: PipelineEvent[];
  running: boolean;
}

const DEFAULT_OPTIONS: GenerationOptions = {
  useImage: true,
  useTts: false,
  useVideoPoints: true,
  // 声音默认开启（#536）：无 BGM 文件时不输出 bgm 指令；内置 SE 有文件就播，
  // 避免新项目默认成「哑剧」（此前默认关闭，标题页与所有场景静音）
  useBgm: true,
  useSe: true,
  figureEmotions: true,
  figureDetail: "full",
  figureActions: true,
  characterPoses: true,
  imageSelfCheck: false,
  imageBudgetPerChapter: 0,
  // 同一地点在单章内的背景上限（0=不限）：默认 3——实测同地点最多被画过 79 次
  // （LLM 给每个场景实例都写一条独一无二的氛围），收敛后仍保留白天/夜晚/情绪差异
  backgroundsPerLocation: 3,
  // #1580 背景复用：默认「地点 × 昼夜 × 天气」——同桶场景共用一张图。
  // 实测某 30 章项目 502 个场景实例里，同一间公寓出现 62 次（8 章）、被画了 24 张几乎一样的夜景
  // （502 条 bgPrompt 无一重复，按提示词去重省不下来），而 VN 的行业常规是一个地点 2~4 张（昼/夜/雨）。
  // 开启后上面的 backgroundsPerLocation 不再生效（复用已从根上消除重复）。
  backgroundReuse: DEFAULT_BACKGROUND_REUSE,
  cgPerChapter: 0,
  skipCache: false,
  videoPointsPerChapter: 0,
  characterIntroCard: true,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: true,
  scriptStyle: "",
  language: "",
  splitMinChapterChars: 3000,
  splitKeepSpecials: false,
  extractChunkChars: 0,
  autoCascadeDownstream: true,
};

export const projectState = reactive<ProjectState>({
  novel: null,
  materials: [],
  outputDir: "",
  options: { ...DEFAULT_OPTIONS },
  lastResult: null,
  visualBible: null,
  visualBibleWarnings: [],
  saveError: null,
  logs: [],
  running: false,
});

let saveTimer: number | undefined;

interface ProjectSnapshot {
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult: { meta: PipelineResult["meta"]; cards: PipelineResult["cards"]; cost: PipelineResult["cost"] } | null;
  visualBible: ProjectVisualBible | null;
}

/**
 * B32：快照改为浅拷贝——只组装需要持久化的顶层字段，小说/素材/选项等按引用共享。
 * 旧实现每次保存都做一次整树 JSON 深拷贝（含整本正文与全部卡片），在保存频繁时会明显卡顿；
 * saveProjectState 内部会自行裁剪写入结构（只持久化需要落盘的章节元数据），无需在此深拷贝。
 */
function snapshotProjectState(): ProjectSnapshot {
  const lastResult = projectState.lastResult;
  return {
    novel: projectState.novel,
    materials: projectState.materials,
    outputDir: projectState.outputDir,
    options: projectState.options,
    lastResult: lastResult ? { meta: lastResult.meta, cards: lastResult.cards, cost: lastResult.cost } : null,
    visualBible: projectState.visualBible,
  };
}

/** 轻量稳定哈希（djb2），用于快照变更检测；正文只用来判等，不参与持久化 */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

/** 上次成功写盘的快照指纹（B32）：AI 分章项目的 project_state.json 内嵌整本分章正文快照，
 *  每次 scheduleSave 都重写数 MB；指纹未变（内容未变）时直接跳过写盘。 */
let lastPersistedSignature = "";

function snapshotSignature(snapshot: ProjectSnapshot): string {
  const novel = snapshot.novel;
  return JSON.stringify({
    out: snapshot.outputDir,
    materials: snapshot.materials.map((m) => `${m.kind}:${m.path}:${m.name}:${m.extra?.mapTo ?? ""}`),
    options: snapshot.options,
    novel: novel
      ? {
          head: `${novel.sourcePath}|${(novel.sourcePaths ?? []).join("|")}|${novel.fileName}|${novel.encoding}`,
          full: hashText(novel.fullText ?? ""),
          chapters: novel.chapters.map((c) => `${c.index}:${c.title}:${c.enabled ?? true}:${hashText(c.text ?? "")}`),
        }
      : null,
    result: snapshot.lastResult
      ? {
          meta: snapshot.lastResult.meta,
          cost: snapshot.lastResult.cost,
          // 与 saveProjectState 的落盘口径一致：内联参考图（base64）不参与持久化也不参与指纹
          cards: hashText(JSON.stringify(snapshot.lastResult.cards, (key, value) => (key === "referenceImage" ? undefined : value))),
        }
      : null,
    bible: snapshot.visualBible ? hashText(JSON.stringify(snapshot.visualBible)) : null,
  });
}

async function persistSnapshot(snapshot: ProjectSnapshot): Promise<boolean> {
  if (!snapshot.outputDir) return true;
  const signature = snapshotSignature(snapshot);
  if (signature === lastPersistedSignature && projectState.saveError === null) return true;
  try {
    await saveProjectState(snapshot);
    lastPersistedSignature = signature;
    projectState.saveError = null;
    return true;
  } catch (error) {
    projectState.saveError = error instanceof Error ? error.message : String(error);
    log.error("store", "项目状态保存失败", {
      outputDir: snapshot.outputDir,
      error: projectState.saveError,
    });
    return false;
  }
}

export async function persistCurrentProjectState(): Promise<boolean> {
  return persistSnapshot(snapshotProjectState());
}

/** 启动恢复期间挂起自动保存：否则恢复完成前的 800ms 防抖会把"空状态"写回磁盘，
 *  项目状态文件（含已导入小说/卡片/失败项）被静默清空（大项目恢复耗时 >800ms 时必现）。 */
let projectSaveSuspended = false;
function suspendProjectSave(suspended: boolean): void {
  projectSaveSuspended = suspended;
}

export function scheduleSave(): void {
  if (projectSaveSuspended) return;
  if (saveTimer !== undefined) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const snapshot = snapshotProjectState();
    log.debug("store", "持久化项目状态", {
      hasNovel: !!snapshot.novel,
      materials: snapshot.materials.length,
      outputDir: snapshot.outputDir,
    });
    void persistSnapshot(snapshot);
  }, 800);
}

export async function flushPendingProjectSave(): Promise<boolean> {
  if (saveTimer === undefined) return true;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  return persistCurrentProjectState();
}

/** 关闭前落盘钩子是否已注册（幂等标记） */
let unloadFlushRegistered = false;

/** 同步可用的「立即落盘」尝试：beforeunload 里 await 不可靠，先触发一次不等结果的写。 */
function flushPendingProjectSaveSync(): void {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const snapshot = snapshotProjectState();
  // 不 await：beforeunload/pagehide 阶段浏览器只给极短时间。
  // 但**必须**先把计时器清掉并把快照交给写盘路径——能写完就写完，写不完下次打开仍走磁盘旧值，
  // 不会比"整段防抖回调根本没跑"更差。
  void persistSnapshot(snapshot).catch(() => undefined);
}

/**
 * 注册关闭前落盘（Web 的 beforeunload/pagehide + Tauri 窗口关闭事件）。
 *
 * 为什么需要：保存有 800ms 防抖，而全仓此前**没有任何**关闭钩子调用 flush
 * （grep beforeunload|pagehide|visibilitychange 无命中）。用户在设置页改完选项、
 * 或加了一个素材后 800ms 内关窗，防抖回调没执行 → project_state.json 里还是旧值，
 * 下次打开改动回退，用户以为已保存。
 *
 * 幂等；在项目加载完成（restoreProject 的 finally）时自动注册，无需 App.vue 改动。
 */
export function registerProjectSaveFlush(): void {
  if (unloadFlushRegistered) return;
  unloadFlushRegistered = true;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const handler = (): void => {
    flushPendingProjectSaveSync();
  };
  // pagehide 比 beforeunload 可靠（移动端/bfcache 场景 beforeunload 可能不触发），两个都注册
  window.addEventListener("pagehide", handler);
  window.addEventListener("beforeunload", handler);
  // Tauri 桌面端：窗口关闭不会触发上面的 Web 事件，必须走 CloseRequested。
  // 动态 import 避免 Web/Node 环境（无 @tauri-apps/api 窗口上下文）在模块加载期报错。
  void (async () => {
    try {
      const { isTauri } = await import("../utils/tauri");
      if (!isTauri()) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          // flush 可能因 IPC 卡住而不返回：加一个上限，否则窗口永远关不掉（用户只能杀进程）。
          // 代价是极端情况下最后一次改动可能没落盘——比"关不掉窗口"轻得多（saveError 会记录）。
          await Promise.race([
            flushPendingProjectSave(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        } catch (e) {
          log.warn("store", "关闭前保存失败（继续关闭窗口）", { error: e instanceof Error ? e.message : String(e) });
        } finally {
          // flush 失败也必须让窗口关掉：卡住用户关窗比丢一次改动更糟（失败已记 saveError）。
          // 注意：destroy() 需要 capabilities 里的 core:window:allow-destroy —— 缺权限时它会被拒绝，
          // 而 preventDefault() 已经把系统默认关闭拦掉了，于是「点 × 毫无反应」（2026-10-14 用户实测）。
          // 这里必须 catch 并留痕，不能再让异常静默吞掉关窗动作。
          try {
            await getCurrentWindow().destroy();
          } catch (e) {
            log.warn("store", "关闭窗口失败：请检查 capabilities 是否缺少 core:window:allow-destroy", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      });
    } catch (e) {
      log.warn("store", "注册窗口关闭前保存钩子失败（不影响其它功能）", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
}

export async function restoreProject(outputDir: string): Promise<void> {
  // #1292：先登记项目目录进桌面端文件白名单——用户工程可位于任意盘符（D 盘等），
  // 不登记则后续读写一律被拒，项目打不开。登记失败不阻断（读到明确拒绝再报）。
  try {
    await tauri.blessProjectDir(outputDir);
  } catch {
    /* 登记失败不阻断，后续文件命令会给出明确拒绝 */
  }
  // 恢复期间挂起自动保存：否则恢复完成前的 800ms 防抖会把"空状态"写回磁盘（大项目恢复 >800ms 必现，
  // 项目状态文件被静默清空）。
  suspendProjectSave(true);
  // B31：无论成功还是失败都必须解挂（finally）。旧实现失败时保持挂起，一次「加载项目」失败
  // 就会让自动保存永久停摆（后续所有改动都不落盘）；失败时 projectState.outputDir 尚未切换，
  // 解挂后的保存仍指向旧项目，不会把新目录的状态文件清空。
  try {
    const projectChanged = outputDir !== projectState.outputDir;
    if (projectChanged && !(await flushPendingProjectSave())) {
      throw new Error("当前项目保存失败，已取消切换项目");
    }
    log.info("store", "恢复项目状态", { outputDir });
    const r = await restoreProjectState(outputDir);
    if (r.loadError) throw new Error(`项目状态读取失败：${r.loadError}`);
    if (projectChanged) {
      clearThumbCache();
      clearLogs();
    }
    projectState.outputDir = outputDir;
    projectState.visualBible = r.visualBible;
    projectState.visualBibleWarnings = r.warnings;
    for (const warning of r.warnings) log.warn("store", warning, { outputDir });
    projectState.novel = r.novel;
    projectState.materials = r.materials;
    projectState.options = { ...DEFAULT_OPTIONS, ...(r.options ?? {}) };
    // #1109 根治：useSe 是可选字段，旧存档/预设套用可能留下显式 undefined——界面 falsy 显示"关"、
    // 引擎 !==false 判"开"，预设还误判为省钱档。加载时归一化为显式布尔，与引擎语义对齐。
    if (projectState.options.useSe === undefined) projectState.options.useSe = true;
    if ((projectState.options as { useBgm?: unknown }).useBgm === undefined) {
      (projectState.options as { useBgm?: boolean }).useBgm = true;
    }
    projectState.lastResult = null;
    // 卡片以磁盘上的工作副本为准（与 pipeline.loadCards 同源）：project_state.json 里的
    // cards 只是上次保存时的快照，生成结束后不一定落盘过，重启后可能与 cards.json 不一致。
    // 不一致会直接打断图像生成：视觉守门批准时用快照算指纹、图像阶段用磁盘算指纹，
    // 于是「刚批准就判输入已变化 → 视觉守门失效 → 图像永不生成」。
    const workingCards = await readWorkingCards(outputDir);
    const snapshot = r.lastResult;
    // 快照里连 lastResult 都没有时（上一轮生成还没保存就退出/被中断），用磁盘上的
    // cards.json + meta.json 把它补出来：否则重启后「单阶段重跑」整块面板变成
    // 「还没有生成结果」，视觉守门的准备/批准按钮拿不到卡片而静默失败（0 个角色），
    // 素材页也是空的，且批准出来的指纹不含任何角色，图像阶段用磁盘卡片复算必然不一致
    // → 视觉守门永远判「输入已变化」，图片一张也生成不出来。
    if (snapshot || workingCards) {
      const chapters = await loadCachedChapters(outputDir);
      const failedTasks = await loadFailedTasks(outputDir);
      // #1509：没有状态快照时，persist 层会交回一个只含 cards 的空壳结果（meta 全空），
      // 这里必须把它当作"没有 meta"来看待、回落到磁盘 meta.json，
      // 否则界面上的作品标题/章节数会变成空白（看起来像项目坏了）。
      const snapshotMeta = snapshot?.meta;
      const metaHasContent = !!snapshotMeta && !!(snapshotMeta.title || snapshotMeta.gameKey || snapshotMeta.generatedAt);
      const meta = metaHasContent ? snapshotMeta! : await loadDiskMeta(outputDir);
      log.debug("store", "恢复项目完成", {
        hasNovel: !!r.novel,
        materials: r.materials?.length ?? 0,
        cachedChapters: chapters.length,
        failedTasks: failedTasks.length,
        cardsFromDisk: !!workingCards,
        resultFromSnapshot: !!snapshot,
      });
      projectState.lastResult = {
        meta,
        cards: workingCards ?? snapshot!.cards,
        cost: snapshot?.cost ?? { ...EMPTY_COST },
        chapters,
        assets: {},
        failedTasks,
      };
    }
    projectState.saveError = null;
    // B35：侧栏失败徽标依赖 generate store 的 watch（懒加载，冷启动进入生成页前不执行）。
    // 恢复完成后直接把磁盘上的失败项数量同步到轻量 runStatus，冷启动也能显示徽标。
    runStatusSetFailed(projectState.lastResult?.failedTasks.length ?? 0);
  } finally {
    suspendProjectSave(false);
    // 项目加载完成即注册关闭前落盘钩子（幂等）：这是应用里"确定有项目可保存"的第一个可靠时点。
    registerProjectSaveFlush();
  }
}

/** 磁盘上没有费用快照时的零值（避免页面把 undefined 显示成 NaN） */
const EMPTY_COST: CostStats = {
  llmTokens: 0,
  imageCount: 0,
  ttsChars: 0,
  llmCostYuan: 0,
  imageCostYuan: 0,
  ttsCostYuan: 0,
};

// 项目元信息（标题/章节数/台词数/引擎版本）只在 .novel2vn/meta.json 里，
// project_state.json 的 lastResult 快照常常不存在，缺了 meta.json 就先生成空壳。
async function loadDiskMeta(outputDir: string): Promise<ProjectMeta> {
  const fallback: ProjectMeta = {
    title: "",
    gameKey: "",
    chapterCount: 0,
    charCount: 0,
    sceneCount: 0,
    lineCount: 0,
    outputDir,
    webgalVersion: "",
    generatedAt: "",
  };
  try {
    const file = `${outputDir}/.novel2vn/meta.json`;
    if (!(await tauri.pathExists(file))) return fallback;
    const { text } = await tauri.readTextFile(file);
    const meta = JSON.parse(text) as Partial<ProjectMeta> | null;
    if (!meta || typeof meta !== "object") return fallback;
    return { ...fallback, ...meta, outputDir };
  } catch {
    return fallback;
  }
}

// 从 .novel2vn/failed.json 恢复失败任务（中断/崩溃/重启后「失败项」仍可定位重试）
async function loadFailedTasks(outputDir: string): Promise<import("../core/types").FailedTask[]> {
  try {
    const file = `${outputDir}/.novel2vn/failed.json`;
    if (!(await tauri.pathExists(file))) return [];
    const { text } = await tauri.readTextFile(file);
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => f && typeof f.id === "string" && typeof f.step === "string");
    }
    return [];
  } catch {
    return [];
  }
}

// 从磁盘缓存恢复各章剧本（供卡片/视频/剧本页在重启后仍可用）
async function loadCachedChapters(outputDir: string): Promise<ChapterScript[]> {
  try {
    const cacheDir = `${outputDir}/.novel2vn/cache`;
    const entries = await tauri.listDir(cacheDir);
    // #1485：demo 与正式剧本必须按当前模式分开挑选。
    // 旧实现用 /^script(?:_demo)?_ch(N)_/ 同时匹配两套，再按 name.localeCompare 取「最新」——
    // 而 "script_demo_ch1_…" 的 'd' > "script_ch1_…" 的 'c'，**演示剧本恒胜**；又不校验指纹，
    // 于是「未配置文本 API 时跑过一次演示」之后，重启恢复出的 lastResult.chapters 会整本变成
    // 演示内容（管线侧 loadChaptersFiltered 本就有这层隔离，store 侧漏做）。
    // 判定口径与管线一致：没有可用的文本 API key 才算演示模式。
    const demo = !activeConfig("llm")?.apiKey;
    // 每章分别收集两种变体的**全部**候选（同名多指纹版本可能是残留或损坏），
    // 先按当前模式取，缺了才回退另一种（避免整章凭空消失）。
    const perChapter = new Map<number, { real: (typeof entries)[number][]; demo: (typeof entries)[number][] }>();
    for (const entry of entries) {
      if (entry.isDir) continue;
      // 段缓存（script_ch5_part1of3_*.json）必须显式排除，与 pipeline.loadChaptersFiltered 同口径。
      // 旧实现只按 /^script(_demo)?_ch(\d+)_/ 匹配，段文件同样命中，而 keepNewest 用 localeCompare
      // 取「更大」的名字：段文件名里 part… 的 'p' 大于真实 rest 的首字符（titleHash 以数字或 a–o 开头），
      // **段文件恒胜** → 只读段文件 → parseChapterScript 因缺 chapter/scenes 抛错 → 整章从
      // lastResult.chapters 消失（章节列表、单阶段重跑勾选、角色出场统计、imageStats 总账一起少一章），
      // 且没有任何提示。
      if (isScriptPartFileName(entry.name)) continue;
      const match = entry.name.match(/^script(_demo)?_ch(\d+)_/);
      if (!match) continue;
      const chapterNumber = Number(match[2]);
      const slot = perChapter.get(chapterNumber) ?? { real: [], demo: [] };
      slot[match[1] ? "demo" : "real"].push(entry);
      perChapter.set(chapterNumber, slot);
    }
    // 每章排出候选顺序，逐个尝试：
    // 旧实现每章只读一个候选，解析失败即整章丢弃。缓存文件损坏/半截 JSON 时，
    // 明明还有另一个可用候选（同模式更旧的版本、或另一模式），却让整章凭空消失。
    const candidatesByChapter = new Map<number, (typeof entries)[number][]>();
    for (const [chapterNumber, slot] of perChapter) {
      // 同模式内按文件名降序（与旧 keepNewest 的 localeCompare「取最新」同序）
      const byNameDesc = (a: (typeof entries)[number], b: (typeof entries)[number]): number => b.name.localeCompare(a.name);
      slot.real.sort(byNameDesc);
      slot.demo.sort(byNameDesc);
      // #1501：隔离是单向的——正式模式绝不允许用演示剧本兜底（演示剧本是"未配置文本 API 时的
      // 占位内容"，灌进正式项目会让整本恢复成演示内容）；演示模式允许用正式缓存兜底。
      const ordered = demo ? [...slot.demo, ...slot.real] : [...slot.real, ...slot.demo];
      if (ordered.length) candidatesByChapter.set(chapterNumber, ordered);
    }
    const loaded = await Promise.all([...candidatesByChapter.values()].map(async (files) => {
      for (const file of files) {
        try {
          const { text } = await tauri.readTextFile(file.path);
          return parseChapterScript(JSON.parse(text));
        } catch (e) {
          // 单个候选损坏不再静默：说明是哪一章的哪个文件坏了（否则用户只看到章节少一章）
          log.warn("store", `剧本缓存候选不可用，尝试下一个：${file.name}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return undefined;
    }));
    return loaded
      .filter((chapter): chapter is ChapterScript => chapter !== undefined)
      .sort((a, b) => a.chapter - b.chapter);
  } catch (e) {
    // 目录不存在是正常情况（新项目），但其它失败（权限/IO）此前被一并吞成空列表，
    // 表现为「重启后章节全没了」而日志里什么都没有。
    log.warn("store", "读取剧本缓存目录失败（本次按无缓存章节恢复）", {
      outputDir,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

watch(
  () =>
    JSON.stringify({
      novelChapters: projectState.novel?.chapters.map((c) => ({ t: c.title, e: c.enabled })),
      novelMeta: projectState.novel
        ? { sourcePath: projectState.novel.sourcePath, fileName: projectState.novel.fileName }
        : null,
      materials: projectState.materials,
      outputDir: projectState.outputDir,
      options: projectState.options,
      lastMeta: projectState.lastResult?.meta.generatedAt,
      visualBible: projectState.visualBible,
    }),
  () => scheduleSave(),
  { deep: false },
);

// #1320：切换项目时重载该项目的导出界面语言（默认 zh_CN，不碰翻译目标）
// 注意：loadExportUiLanguage 定义在文件后部，此处不 immediate，改由定义后显式初载，避免 TDZ
watch(
  () => projectState.outputDir,
  () => {
    try {
      loadExportUiLanguage();
    } catch {
      /* 定义前触发时忽略，初载由底部显式调用 */
    }
  },
);

export function clearLogs(): void {
  projectState.logs = [];
  for (const k of Object.keys(stageLastLevels) as StageKey[]) stageLastLevels[k] = undefined;
  lastActiveStage = undefined;
}

/** 增量维护：每个阶段日志的「最后一条级别」，避免每次 pushLog 全量扫描 2000 条日志 */
const stageLastLevels = reactive<Record<StageKey, PipelineEvent["level"] | undefined>>({
  split: undefined,
  translate: undefined,
  extract: undefined,
  script: undefined,
  image: undefined,
  voice: undefined,
  assemble: undefined,
});

/** 最近一条非 error 日志对应的阶段（当前正在执行/刚完成的阶段） */
let lastActiveStage: StageKey | undefined;

export function getStageLastLevels(): Record<StageKey, PipelineEvent["level"] | undefined> {
  return stageLastLevels;
}

export function getLastActiveStage(): StageKey | undefined {
  return lastActiveStage;
}

/** B36：每次运行开始时清除「最近活跃阶段」。
 *  lastActiveStage 增量维护且运行结束不清空，新一轮开始瞬间看板会把上一轮的阶段显示成「进行中」；
 *  由调用方（execute 置 busy=true 处）在运行开始时显式重置。 */
export function resetActiveStage(): void {
  lastActiveStage = undefined;
}

export function pushLog(ev: PipelineEvent): void {
  projectState.logs.push(ev);
  if (projectState.logs.length > 2000) {
    projectState.logs.splice(0, projectState.logs.length - 2000);
  }
  const stage = STEP_TO_STAGE[ev.step];
  if (stage) {
    // 阶段成功/进行中的新日志到达即覆盖旧 error：失败后重跑该阶段时红色状态会随新日志消除；
    // 无新日志的阶段仍需显式 resetStageLevel（或 clearLogs）。消费端（useStageStatus）
    // 同时应把 running 判定置于 failed 之前，避免重试期间仍显示失败。
    stageLastLevels[stage] = ev.level;
    if (ev.level !== "error") lastActiveStage = stage;
  }
  // 统一日志出口：pushLog 此前只进 projectState.logs（生成页「运行日志」tab），
  // 侧栏运行日志与磁盘 novelforge.log 都看不到分章/提取/剧本/图像/配音等阶段消息——
  // 用户排查时「日志里什么都没有」正是这个原因。转投 logger 后两条流合一，
  // 侧栏、磁盘文件、内存历史拿到的是同一份内容。
  const write = ev.level === "error" ? log.error
    : ev.level === "warn" ? log.warn
    : ev.level === "success" ? log.success
    : log.info;
  write(ev.step, ev.message);
}

export function addMaterial(mat: MaterialAsset): void {
  if (projectState.materials.some((m) => m.path === mat.path)) return;
  projectState.materials.push(mat);
}

export function removeMaterial(path: string): void {
  projectState.materials = projectState.materials.filter((m) => m.path !== path);
}

/* ==================== #1320 导出语言 vs 翻译目标语言（store 侧写入口径） ==================== */

/**
 * #1320：同一字段两种语义导致静默覆盖——设置页 options.language=“翻译目标（空=不翻译）”，
 * 导出页“界面语言”此前用 `(o.language)||"zh_CN"` 回填并无条件写回，把空语言写成 zh_CN，
 * 下次生成静默激活整书翻译（计费）。
 *
 * store 侧修复（UI 侧由他人负责迁移到 setExportUiLanguage）：
 * - 翻译目标：空字符串必须保持空语义（不触发翻译），永不回退 zh_CN；
 * - 导出界面语言：独立状态 exportSettings.uiLanguage（zh_CN/zh_TW/en/ja/ko），不再复用 options.language；
 * - 导出保存写入口径：仅当用户真的改动翻译目标（touched）才写，否则保持原值。
 */

const EXPORT_UI_LANGUAGES = ["zh_CN", "zh_TW", "en", "ja", "ko"] as const;
type ExportUiLanguage = (typeof EXPORT_UI_LANGUAGES)[number];

/** 纯函数：界面语言归一化（无空语义，非法/空一律回退 zh_CN） */
export function normalizeExportUiLanguage(v: unknown): ExportUiLanguage {
  const s = typeof v === "string" ? v.trim() : "";
  return (EXPORT_UI_LANGUAGES as readonly string[]).includes(s) ? (s as ExportUiLanguage) : "zh_CN";
}



/** 导出界面语言（独立于翻译目标；按项目目录持久化到 localStorage，不进管线指纹） */
export const exportSettings = reactive<{ uiLanguage: ExportUiLanguage }>({ uiLanguage: "zh_CN" });

function exportUiKey(): string {
  return `novelforge:exportUi:${projectState.outputDir || "default"}`;
}

export function loadExportUiLanguage(): void {
  try {
    const raw = localStorage.getItem(exportUiKey());
    if (raw === null) {
      // 老项目迁移：此前界面语言与翻译目标共用 options.language，非空即沿用，保证旧项目行为不变；
      // 之后两字段独立演进（界面语言改下拉，翻译目标改设置页）。
      const legacy = (projectState.options.uiLanguage || projectState.options.language || "").trim();
      exportSettings.uiLanguage = normalizeExportUiLanguage(legacy || "zh_CN");
      return;
    }
    exportSettings.uiLanguage = normalizeExportUiLanguage(raw);
  } catch {
    exportSettings.uiLanguage = "zh_CN";
  }
}

export function setExportUiLanguage(v: unknown): ExportUiLanguage {
  const next = normalizeExportUiLanguage(v);
  exportSettings.uiLanguage = next;
  try {
    localStorage.setItem(exportUiKey(), next);
  } catch {
    /* 忽略 */
  }
  return next;
}

/** 翻译目标写入口（保持空语义；UI 侧设置页/导出页统一走这里，不再 `|| "zh_CN"`） */

// #1320 初载（对应顶部 watch 的非 immediate 设计）：模块初始化完成后按当前项目载入一次
try {
  loadExportUiLanguage();
} catch {
  /* 忽略 */
}
