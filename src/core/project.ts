import type { ChapterScript, ExtractionResult, ProjectMeta } from "./types";
import type { RenderAssets, WebgalLanguage } from "./render";
import { renderChapter, renderConfig, renderStart, sanitizeId } from "./render";
import { tauri, type FsEntry } from "../utils/tauri";
import { basename, joinPath, normalizePath } from "../utils/path";
import { log } from "../utils/logger";
import { errMsg } from "../utils/errors";
import { ConcurrencyLimiter } from "../utils/performance";
import { brandUrl, brandFooterHtml } from "../utils/branding";
import { extractAccentFromImage, hslOf, type AccentPair } from "./themeColors";

export interface AssembleInput {
  outputDir: string;
  title: string;
  gameKey: string;
  templateDir: string;
  chapters: ChapterScript[];
  cards: ExtractionResult;
  assets: RenderAssets;
  introCard?: boolean;
  figureEmotions?: boolean;
  /** 人物动作（入场/情绪动作/镜头震动），默认开启 */
  figureActions?: boolean;
  useBgm?: boolean;
  /** 环境音效（SE）：默认关闭（与 useBgm 同为「声音」开关） */
  useSe?: boolean;
  /** 界面语言（默认 zh_CN）；正文语言由翻译阶段决定 */
  language?: WebgalLanguage;
  /** 标题封面：auto=按主题自动生成（默认）；none=不使用封面；custom=用 titleCoverPath */
  titleCoverMode?: "auto" | "none" | "custom";
  /** 自定义封面图片路径（Tauri 绝对路径或 Web vfs 路径） */
  titleCoverPath?: string;
  /** 标题 Logo：auto=自动生成文字 Logo（默认）；none=不显示；custom=用 titleLogoPath */
  titleLogoMode?: "auto" | "none" | "custom";
  titleLogoPath?: string;
  /** 标题曲：game/bgm 下的文件名；"none"=不播放；空=自动匹配宁静曲目 */
  titleBgmFile?: string;
  /** 标题菜单开关（默认 true） */
  titleEnableContinue?: boolean;
  titleEnableFlowchart?: boolean;
  titleEnableAppreciation?: boolean;
  /** 主题色随画风：从视觉守门风格图/首张背景提取主色（默认 true；无图时用默认紫罗兰） */
  themeFromArtwork?: boolean;
  /** 视觉守门风格参考图（绝对路径），用于主题取色 */
  styleReferencePath?: string;
  /** 视觉模式（#810）：sprite=立绘版（默认）；imageOnly=图片小说（渲染无立绘、按分镜切图） */
  mode?: "sprite" | "imageOnly";
  log: (msg: string) => void;
}

export async function assembleProject(input: AssembleInput): Promise<{ gameDir: string; meta: ProjectMeta }> {
  const { outputDir, title, gameKey, templateDir } = input;
  const done = log.time("project", `组装项目「${title}」`);
  log.info("project", "开始组装项目", { outputDir, templateDir, title, gameKey, chapters: input.chapters.length });
  
  // 标准化路径
  const normalizedOutputDir = normalizePath(outputDir);
  const normalizedTemplateDir = normalizePath(templateDir);
  
  await tauri.mkdirAll(normalizedOutputDir);
  await tauri.mkdirAll(joinPath(normalizedOutputDir, "game/scene"));
  await tauri.mkdirAll(joinPath(normalizedOutputDir, "game/background"));
  await tauri.mkdirAll(joinPath(normalizedOutputDir, "game/figure"));
  await tauri.mkdirAll(joinPath(normalizedOutputDir, "game/vocal"));
  await tauri.mkdirAll(joinPath(normalizedOutputDir, "game/bgm"));

  // 清理旧场景文件（章节减少后防止残留）
  try {
    const sceneDir = joinPath(normalizedOutputDir, "game/scene");
    const sceneEntries = await tauri.listDir(sceneDir);
    for (const e of sceneEntries) {
      if (!e.isDir && e.name.endsWith(".txt")) {
        await tauri.removePath(e.path).catch(() => {});
      }
    }
  } catch {
    /* 目录不可用 */
  }

  input.log("复制引擎文件…");
  const engineFiles = [
    "index.html",
    "manifest.json",
    "webgal-engine.json",
    "webgal-serviceworker.js",
  ];
  for (const f of engineFiles) {
    try {
      await tauri.copyFile(
        joinPath(normalizedTemplateDir, f),
        joinPath(normalizedOutputDir, f)
      );
    } catch {
      input.log(`跳过引擎文件 ${f}（模板中不存在）`);
    }
  }
  // 导出游戏内注入品牌水印（官网推广；地址运行时拼装，源码无明文）+ 页面标题改为作品名
  await injectBrandFooter(normalizedOutputDir, title);
  await copyDirIfExists(
    joinPath(normalizedTemplateDir, "assets"),
    joinPath(normalizedOutputDir, "assets")
  );
  await copyDirIfExists(
    joinPath(normalizedTemplateDir, "icons"),
    joinPath(normalizedOutputDir, "icons")
  );
  await copyDirIfExists(
    joinPath(normalizedTemplateDir, "game/template"),
    joinPath(normalizedOutputDir, "game/template")
  );
  await copyDirIfExists(
    joinPath(normalizedTemplateDir, "game/animation"),
    joinPath(normalizedOutputDir, "game/animation")
  );
  // WebGAL 引擎启动必需文件：flowchart.json（流程图）与 userStyleSheet.css（用户样式）。
  // 缺失会导致引擎启动报 404 并影响渲染初始化（图片不显示 / 流程图报错）。
  for (const f of ["flowchart.json", "userStyleSheet.css"]) {
    try {
      await tauri.copyFile(
        joinPath(normalizedTemplateDir, "game", f),
        joinPath(normalizedOutputDir, "game", f),
      );
    } catch {
      /* 模板缺失则跳过 */
    }
  }

  input.log("渲染剧本文件…");
  const chapterCount = input.chapters.length;
  const seenCharacters = new Set<string>();
  const videos = await detectVideos(normalizedOutputDir);
  const bgmMap = input.useBgm === false ? {} : await detectBgm(normalizedOutputDir, input.chapters);

  // 主题取色：视觉守门风格参考图(锚点) → 首张背景 → 首张 CG；全部失败或无图 → 默认紫罗兰
  let accents: AccentPair | null = null;
  if (input.themeFromArtwork !== false) {
    const candidates = [
      input.styleReferencePath,
      Object.values(input.assets.bg)[0],
      Object.values(input.assets.cg)[0],
    ].filter((p): p is string => !!p);
    for (const src of candidates) {
      accents = await extractAccentFromImage(src, (p) => tauri.readFileBase64(p));
      if (accents) break;
    }
  }

  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, "game/scene/start.txt"),
    renderStart(chapterCount, title),
  );

  for (const chapter of input.chapters) {
    const txt = renderChapter(chapter, {
      characters: input.cards.characters,
      items: input.cards.items,
      assets: { ...input.assets, bgm: bgmMap },
      videos,
      seenCharacters,
      introCard: input.introCard,
      figureEmotions: input.figureEmotions,
      figureActions: input.figureActions,
      useSe: input.useSe,
      mode: input.mode,
    }, chapterCount);
    await tauri.writeTextFile(
      joinPath(normalizedOutputDir, `game/scene/ch${chapter.chapter + 1}.txt`),
      txt
    );
  }
  // 流程图：按实际章节重建节点/连线（模板自带 demo 节点会让流程图与鉴赏跳向不存在的场景）
  await writeFlowchart(normalizedOutputDir, input.chapters, title);

  // 标题画面：封面/Logo 支持 自动生成 / 不使用 / 自定义图片；标题曲可指定或自动匹配
  const coverMode = input.titleCoverMode ?? "auto";
  const logoMode = input.titleLogoMode ?? "auto";
  const wantAutoCover = coverMode === "auto";
  const wantAutoLogo = logoMode === "auto";
  const autoArt = wantAutoCover || wantAutoLogo
    ? await generateTitleAssets(normalizedOutputDir, title, wantAutoCover, wantAutoLogo, accents)
    : null;
  const customCover = coverMode === "custom" && input.titleCoverPath
    ? await copyTitleAsset(input.titleCoverPath, normalizedOutputDir, "nf_title_cover")
    : null;
  const customLogo = logoMode === "custom" && input.titleLogoPath
    ? await copyTitleAsset(input.titleLogoPath, normalizedOutputDir, "nf_game_logo")
    : null;
  const titleImg = coverMode === "none" ? undefined : (customCover ?? autoArt?.cover ?? pickTitleImage(input.assets));
  const gameLogo = logoMode === "none" ? undefined : (customLogo ?? autoArt?.logo);
  const titleBgm = input.titleBgmFile === "none"
    ? undefined
    : input.titleBgmFile && input.titleBgmFile.trim()
      ? input.titleBgmFile.trim()
      : pickTitleBgm(bgmMap);

  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, "game/config.txt"),
    renderConfig(title, gameKey, input.language ?? "zh_CN", titleImg, titleBgm, gameLogo, {
      continue: input.titleEnableContinue,
      flowchart: input.titleEnableFlowchart,
      appreciation: input.titleEnableAppreciation,
    }),
  );

  input.log("复制素材…");
  await copyAssets(input.assets, normalizedOutputDir);

  await copyBuiltinSe(normalizedOutputDir, input);
  await writeAppreciation(normalizedOutputDir, input, bgmMap);
  // 每部作品的主题样式（主题色变量 + 语言字体栈 + 入口常显标题 + 可访问性/窄屏）追加到 userStyleSheet 末尾
  await writeGameThemeCss(normalizedOutputDir, title, input.language ?? "zh_CN", accents);

  await writeVideoPlan(normalizedOutputDir, input.chapters, videos);
  await writeExportGuide(normalizedOutputDir, title);
  // 玩家上手指南（WebGAL 无内置教学）
  await writeHowToPlay(normalizedOutputDir, title);

  const meta: ProjectMeta = {
    title,
    gameKey,
    chapterCount,
    charCount: input.cards.characters.length,
    sceneCount: input.chapters.reduce((n, c) => n + c.scenes.length, 0),
    lineCount: input.chapters.reduce(
      (n, c) => n + c.scenes.reduce((m, s) => m + s.lines.length, 0),
      0,
    ),
    outputDir: normalizedOutputDir,
    webgalVersion: "4.6.3",
    generatedAt: new Date().toISOString(),
  };
  
  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, ".novel2vn/meta.json"),
    JSON.stringify(meta, null, 2),
  );
  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, ".novel2vn/cards.json"),
    JSON.stringify(input.cards, null, 2),
  );
  // 构建信息 + PWA 名称/图标跟随作品
  await writeBuildInfo(normalizedOutputDir, meta);
  await patchManifestAndIcons(normalizedOutputDir, title, titleImg);

  done(`输出目录 ${normalizedOutputDir}`);
  log.info("project", "项目组装完成", { outputDir: normalizedOutputDir, meta });

  return { gameDir: normalizedOutputDir, meta };
}

/**
 * 内置环境音效（SE）：从 WebGAL 模板 game/vocal/（随应用资源打包，路径可靠）复制到输出 game/vocal/。
 * 用户同名文件已存在时跳过（用户素材优先）。
 * 旧实现用 process.cwd()+"/src/gameExtra/se"，打包后 cwd 非源码目录导致 SE 从未复制（playEffect 404）。
 */
async function copyBuiltinSe(outputDir: string, input: AssembleInput): Promise<void> {
  // useSe === false（默认关闭音效）时成品不会输出任何 playEffect，内置 SE 无需复制（省 8 个文件与一次 IPC）。
  // 与 render 的 useSe 口径一致：undefined 视为开启（兼容旧项目），仅显式 false 跳过。
  if (input.useSe === false) return;
  try {
    const seDir = joinPath(input.templateDir, "game/vocal");
    const entries = await tauri.listDir(seDir).catch(() => [] as FsEntry[]);
    for (const e of entries) {
      if (e.isDir || !e.name.endsWith(".wav")) continue;
      const dest = joinPath(outputDir, "game/vocal", e.name);
      if (await tauri.pathExists(dest)) continue; // 用户同名覆盖优先
      await tauri.copyFile(e.path, dest);
    }
  } catch {
    /* SE 缺失不影响游戏 */
  }
}

/** 鉴赏室：生成素材清单数据（appreciation-data.js）+ 复制鉴赏页（立绘换装/表情/动作/缩放、CG/背景画廊、角色图鉴、BGM 试听） */
async function writeAppreciation(outputDir: string, input: AssembleInput, bgmMap: Record<string, string>): Promise<void> {
  const basename = (p?: string) => (p || "").split(/[\\/]/).pop() || "";
  const stripExt = (f: string) => f.replace(/\.(png|jpg|jpeg|webp|gif)$/i, "");
  // 场景元数据：CG/背景的 assets key 已是 scene.id（images.ts），
  // 旧实现从 key 解析 `^(\d+)_` 章节号——CG 键改成 scene.id 后分组恒为 1、名称显示文件名（UI94）
  const sceneMeta = new Map<string, { location: string; chapter: number; cgTitle?: string }>();
  for (const c of input.chapters) {
    for (const s of c.scenes) {
      if (!sceneMeta.has(s.id)) {
        sceneMeta.set(s.id, { location: s.location, chapter: c.chapter + 1, cgTitle: s.cgEvent?.title });
      }
    }
  }
  // 立绘文件清单（UI105/108）：鉴赏室只能展示真实存在的文件——
  // 服装差分只有 normal、动作立绘独立于表情，旧实现盲拼「服装+表情」路径必然 404。
  // 按生成端 key 规则归属到角色，供页面把（服装×表情×动作）展平成可前后切换的序列。
  type FigVariant = { file: string; costume?: string; emotion?: string; action?: string };
  const variantsByChar = new Map<string, FigVariant[]>();
  const charIdsByLength = [...input.cards.characters].sort((a, b) => b.id.length - a.id.length);
  const ownerOf = (key: string): { charId: string; rest: string } | null => {
    for (const c of charIdsByLength) {
      if (key === c.id) return { charId: c.id, rest: "" };
      if (key.startsWith(`${c.id}_`)) return { charId: c.id, rest: key.slice(c.id.length + 1) };
    }
    return null;
  };
  const seenFigures = new Set<string>();
  for (const [key, p] of Object.entries(input.assets.figure)) {
    const file = basename(p);
    if (!file) continue;
    const owner = ownerOf(key);
    if (!owner) continue;
    if (seenFigures.has(`${owner.charId}/${file}`)) continue;
    seenFigures.add(`${owner.charId}/${file}`);
    const list = variantsByChar.get(owner.charId) ?? [];
    if (!owner.rest) list.push({ file, emotion: "normal" });
    else if (owner.rest.startsWith("ct_")) list.push({ file, costume: owner.rest.slice(3), emotion: "normal" });
    else if (owner.rest.startsWith("act_")) list.push({ file, action: owner.rest.slice(4) });
    else list.push({ file, emotion: owner.rest });
    variantsByChar.set(owner.charId, list);
  }
  const characters = input.cards.characters.map((c) => ({
    id: c.id,
    name: c.name,
    clothing: c.clothing,
    appearance: c.appearance,
    isNpc: c.isNpc === true,
    costumes: (c.costumes || []).map((ct) => ({ id: ct.id, name: ct.name })),
    actions: (c.actions || []).map((a) => ({ id: a.id, name: a.name })),
    emotions: c.emotions,
    // 真实存在的立绘文件（页面据此生成下拉与序列；缺失文件不再盲拼 URL）
    variants: variantsByChar.get(c.id) ?? [],
  }));
  // CG 按章节分组（chapter 从 1 计）；名称优先 CG 事件标题，其次场景地点，最后文件名
  const cgEntries = Object.entries(input.assets.cg);
  const seenCg = new Set<string>();
  const cgs: Array<{ file: string; name: string; chapter: number }> = [];
  for (const [key, p] of cgEntries) {
    const file = basename(p);
    if (!file || seenCg.has(file)) continue;
    seenCg.add(file);
    const meta = sceneMeta.get(key) ?? sceneMeta.get(key.replace(/^\d+_/, ""));
    cgs.push({
      file,
      name: meta?.cgTitle || meta?.location || stripExt(file),
      chapter: meta?.chapter ?? 1,
    });
  }
  cgs.sort((a, b) => a.chapter - b.chapter || a.file.localeCompare(b.file));
  // UI95：背景画廊（键为 scene.id，名称用场景地点，按章节筛选）
  const seenBg = new Set<string>();
  const bgs: Array<{ file: string; location: string; name: string; chapter: number }> = [];
  for (const [key, p] of Object.entries(input.assets.bg)) {
    const file = basename(p);
    if (!file || seenBg.has(file)) continue;
    seenBg.add(file);
    const meta = sceneMeta.get(key) ?? sceneMeta.get(key.replace(/^\d+_/, ""));
    bgs.push({
      file,
      location: meta?.location || "",
      name: meta?.location || stripExt(file),
      chapter: meta?.chapter ?? 1,
    });
  }
  bgs.sort((a, b) => a.chapter - b.chapter || a.file.localeCompare(b.file));
  // 图片小说分镜画廊（#811）：键为 `<sceneId>_shot<N>`，按章节分组展示
  const seenShot = new Set<string>();
  const shots: Array<{ file: string; name: string; chapter: number }> = [];
  for (const [key, p] of Object.entries(input.assets.shot ?? {})) {
    const file = basename(p);
    if (!file || seenShot.has(file)) continue;
    seenShot.add(file);
    const sceneId = key.replace(/_shot\d+$/, "");
    const meta = sceneMeta.get(sceneId) ?? sceneMeta.get(sceneId.replace(/^\d+_/, ""));
    shots.push({
      file,
      name: meta?.location || stripExt(file),
      chapter: meta?.chapter ?? 1,
    });
  }
  shots.sort((a, b) => a.chapter - b.chapter || a.file.localeCompare(b.file));
  // BGM 鉴赏清单必须用实际 detectBgm 扫到的 bgmMap（input.assets.bgm 恒为空，旧实现导致鉴赏室无 BGM）
  const bgms = [...new Set(Object.values(bgmMap))].map((p) => ({
    file: basename(p),
    name: basename(p).replace(/\.(mp3|ogg|wav|m4a|opus)$/i, ""),
  }));
  // UI97：写入作品语言（与 config.txt 的 Default_Language 同一口径），鉴赏室初始语言不再只看浏览器
  const data = { lang: input.language ?? "zh_CN", characters, cgs, bgs, bgms, shots };
  const js = `window.APPRECIATION_DATA = ${JSON.stringify(data)};\n`;
  try {
    await tauri.writeTextFile(joinPath(outputDir, "appreciation-data.js"), js);
    // 鉴赏页模板随模板目录分发（与 index.html 平级，浏览器直接打开即可）。
    // 旧实现用 process.cwd()+"/src/gameExtra/appreciation.html"，打包后 cwd 非源码目录导致从未复制。
    const tpl = joinPath(input.templateDir, "appreciation.html");
    await tauri.copyFile(tpl, joinPath(outputDir, "appreciation.html"));
  } catch (e) {
    input.log(`鉴赏室资源写入失败（不影响游戏本体）：${errMsg(e).slice(0, 80)}`);
  }
}

/** 标题画面图：优先取第一章首张 CG（名场面最适合做标题视觉），否则取首张背景图 */
function pickTitleImage(assets: RenderAssets): string | undefined {
  const cg = Object.values(assets.cg)[0];
  if (cg) return basename(cg);
  const bg = Object.values(assets.bg)[0];
  return bg ? basename(bg) : undefined;
}

/** 标题背景音乐：优先宁静/舒缓氛围的 BGM，否则取第一首 */
function pickTitleBgm(bgmMap: Record<string, string>): string | undefined {
  const calm = Object.values(bgmMap).find((p) => /calm|peace|piano|ambient|静|平|安|舒缓/i.test(basename(p)));
  const first = Object.values(bgmMap)[0];
  const picked = calm ?? first;
  return picked ? basename(picked) : undefined;
}

/** 标题视觉：用 Canvas 生成「封面 / 文字 Logo」（按需生成），配色跟随主题取色（默认紫罗兰）。
 *  注意引擎把 Title_img / Game_Logo 按 `./game/background/<值>` 解析（与背景图同目录），
 *  因此写入 game/background/ 且配置值用纯文件名；无 DOM（node 单测）或绘图失败返回 null，
 *  调用方回退到「第一章 CG / 首张背景」的老逻辑（缺失的 Title_img 会让入口页卡在白色遮罩）。 */
async function generateTitleAssets(
  outputDir: string,
  title: string,
  wantCover: boolean,
  wantLogo: boolean,
  accents: AccentPair | null,
): Promise<{ cover?: string; logo?: string } | null> {
  if (typeof document === "undefined") return null;
  try {
    const ac = accents?.accent ?? { h: 263, s: 68, l: 62 };
    const ac2 = accents?.accent2 ?? { h: 285, s: 60, l: 68 };
    const deep = `hsl(${Math.round(ac.h)}, ${Math.round(Math.max(26, ac.s * 0.5))}%, 24%)`;
    const make = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      return ctx ? { canvas, ctx } : null;
    };
    const FONT_STACK = '"Resource Han Rounded CN", "OPPOSans", "Source Han Serif CN", "Microsoft YaHei", system-ui, sans-serif';
    const setLetterSpacing = (ctx: CanvasRenderingContext2D, px: number): void => {
      try {
        (ctx as unknown as { letterSpacing?: string }).letterSpacing = `${px}px`;
      } catch {
        /* 旧内核忽略：仅损失字距 */
      }
    };
    const fitFont = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number): number => {
      let size = startSize;
      for (;;) {
        ctx.font = `bold ${size}px ${FONT_STACK}`;
        if (ctx.measureText(text).width <= maxWidth || size <= 40) return size;
        size -= 6;
      }
    };

    const dir = joinPath(outputDir, "game/background");
    await tauri.mkdirAll(dir);
    const result: { cover?: string; logo?: string } = {};

    if (wantCover) {
      // ---- 封面 1920x1080（与主菜单左侧按钮栏的暗色遮罩协调）----
      const cover = make(1920, 1080);
      if (!cover) return null;
      const c = cover.ctx;
      const base = c.createRadialGradient(520, 180, 120, 960, 540, 1700);
      base.addColorStop(0, deep);
      base.addColorStop(0.55, "#0e1120");
      base.addColorStop(1, "#05070d");
      c.fillStyle = base;
      c.fillRect(0, 0, 1920, 1080);
      const glow = c.createRadialGradient(430, 150, 0, 430, 150, 900);
      glow.addColorStop(0, hslOf(ac, 0.38));
      glow.addColorStop(1, hslOf(ac, 0));
      c.fillStyle = glow;
      c.fillRect(0, 0, 1920, 1080);
      const scrim = c.createLinearGradient(0, 540, 0, 1080);
      scrim.addColorStop(0, "rgba(5, 7, 14, 0)");
      scrim.addColorStop(1, "rgba(5, 7, 14, 0.82)");
      c.fillStyle = scrim;
      c.fillRect(0, 0, 1920, 1080);
      // 标题块放右半侧：左侧留给主菜单按钮栏，避免标题与按钮重叠（且容忍引擎轻微的 cover 裁切）
      c.textAlign = "right";
      setLetterSpacing(c, 12);
      c.font = `600 28px ${FONT_STACK}`;
      c.fillStyle = hslOf(ac2, 0.95);
      c.fillText("VISUAL NOVEL", 1792, 668);
      const size = fitFont(c, title, 700, 96);
      setLetterSpacing(c, Math.round(size * 0.06));
      c.shadowColor = hslOf(ac, 0.55);
      c.shadowBlur = 42;
      c.fillStyle = "#f4f1ff";
      c.fillText(title, 1792, 792);
      c.shadowBlur = 0;
      const lineW = Math.max(200, Math.min(520, c.measureText(title).width * 0.5));
      const lineGrad = c.createLinearGradient(1792 - lineW, 0, 1792, 0);
      lineGrad.addColorStop(0, hslOf(ac2, 0));
      lineGrad.addColorStop(1, hslOf(ac2, 0.95));
      c.fillStyle = lineGrad;
      c.fillRect(1792 - lineW, 822, lineW, 5);
      const vig = c.createRadialGradient(960, 540, 480, 960, 540, 1180);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.42)");
      c.fillStyle = vig;
      c.fillRect(0, 0, 1920, 1080);
      const coverB64 = cover.canvas.toDataURL("image/png").split(",")[1] ?? "";
      if (coverB64) {
        await tauri.writeFileBase64(joinPath(dir, "nf_title_cover.png"), coverB64);
        result.cover = "nf_title_cover.png";
      }
    }

    if (wantLogo) {
      // ---- 文字 Logo 1000x320（透明底，入口页/菜单页叠加显示）----
      const logo = make(1000, 320);
      if (!logo) return result.cover ? result : null;
      const l = logo.ctx;
      l.textBaseline = "middle";
      l.textAlign = "center";
      const lsize = fitFont(l, title, 900, 150);
      setLetterSpacing(l, Math.round(lsize * 0.05));
      l.lineWidth = 10;
      l.strokeStyle = "rgba(8, 10, 18, 0.85)";
      l.strokeText(title, 500, 168);
      const logoGrad = l.createLinearGradient(0, 40, 0, 280);
      logoGrad.addColorStop(0, "#ffffff");
      logoGrad.addColorStop(1, hslOf(ac2));
      l.shadowColor = hslOf(ac, 0.45);
      l.shadowBlur = 26;
      l.fillStyle = logoGrad;
      l.fillText(title, 500, 168);
      const logoB64 = logo.canvas.toDataURL("image/png").split(",")[1] ?? "";
      if (logoB64) {
        await tauri.writeFileBase64(joinPath(dir, "nf_game_logo.png"), logoB64);
        result.logo = "nf_game_logo.png";
      }
    }

    return result.cover || result.logo ? result : null;
  } catch (e) {
    log.warn("project", `标题视觉生成失败，回退内置取图：${errMsg(e).slice(0, 100)}`);
    return null;
  }
}

/** 自定义标题图（封面/Logo）：复制进 game/background 并返回纯文件名 */
async function copyTitleAsset(src: string, outputDir: string, baseName: string): Promise<string | null> {
  try {
    const ext = (src.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const name = `${baseName}.${ext}`;
    await tauri.copyFile(src, joinPath(outputDir, "game/background", name));
    return name;
  } catch (e) {
    log.warn("project", `自定义标题图片复制失败（改用自动封面）：${errMsg(e).slice(0, 100)}`);
    return null;
  }
}

/** 每局主题样式的幂等标记：重跑时截断到标记前再追加，保证不重复 */
const PER_GAME_MARKER = "/* ===== NovelForge per-game overrides ===== */";

/** 语言 → 字体栈（引擎默认写死思源宋体 CN，外文语言缺字形/字形难看）。
 *  UI103：模板实际注册的字体只有「资源圆体 / 思源宋体 / WebgalUI」（见引擎 @font-face），
 *  旧栈用 "Resource Han Rounded CN"/"Source Han Serif CN" 这些不存在的名字导致全部回退系统字体；
 *  后置的 Noto/Yu Mincho/Malgun 等是系统字体兜底（缺失时自然跳过）。 */
const FONT_STACKS: Record<string, string> = {
  zh_CN: '"资源圆体", "思源宋体", "Microsoft YaHei", system-ui, sans-serif',
  zh_TW: '"资源圆体", "思源宋体", "Microsoft JhengHei", system-ui, sans-serif',
  en: '"WebgalUI", "资源圆体", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  ja: '"思源宋体", "Source Han Serif JP", "Noto Serif CJK JP", "Yu Mincho", "Hiragino Mincho ProN", "资源圆体", serif',
  ko: '"Malgun Gothic", "Noto Sans KR", "WebgalUI", "资源圆体", "Apple SD Gothic Neo", sans-serif',
};

/** UI104：首屏「点击任意处开始」文案（模板 userStyleSheet.css 写死中文，由每局 CSS 按语言覆盖） */
const ENTER_TEXTS: Record<string, string> = {
  zh_CN: "点击任意处开始",
  zh_TW: "點擊任意處開始",
  en: "CLICK ANYWHERE TO START",
  ja: "画面をクリックして開始",
  ko: "화면을 클릭하여 시작",
};

/** CSS 字符串字面量转义（content: "..." 中的引号/反斜杠/换行） */
function cssEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").trim();
}

/** 每部作品的主题样式：追加到 game/userStyleSheet.css 末尾（主题色变量 + 语言字体栈 + 入口常显标题 + 可访问性/窄屏） */
async function writeGameThemeCss(
  outputDir: string,
  title: string,
  language: WebgalLanguage,
  accents: AccentPair | null,
): Promise<void> {
  const cssPath = joinPath(outputDir, "game/userStyleSheet.css");
  try {
    const { text } = await tauri.readTextFile(cssPath);
    await tauri.writeTextFile(cssPath, buildThemeCss(text, title, language, accents));
  } catch (e) {
    log.warn("project", `每局主题样式写入失败（不影响游戏）：${errMsg(e).slice(0, 100)}`);
  }
}

/** 流程图 JSON（纯函数，便于单测）：按实际章节重建节点与连线（模板自带 demo 节点会指向不存在的场景） */
export function buildFlowchartJson(chapters: ChapterScript[], title: string): string {
  const nodes = [
    {
      id: "start",
      type: "root",
      position: { x: 250, y: 0 },
      data: { label: title || "开始", sceneName: "start.txt", isRoot: true },
    },
    ...chapters.map((c, i) => ({
      id: `ch${c.chapter + 1}`,
      type: "chapter",
      position: { x: 120 + (i % 5) * 240, y: 140 + Math.floor(i / 5) * 140 },
      data: { label: `第 ${c.chapter + 1} 章${c.title ? ` ${c.title}` : ""}`, sceneName: `ch${c.chapter + 1}.txt` },
    })),
  ];
  const edges = chapters.map((c, i) => {
    const prev = i === 0 ? "start" : `ch${c.chapter}`;
    return { id: `e-${prev}-ch${c.chapter + 1}`, source: prev, target: `ch${c.chapter + 1}` };
  });
  return JSON.stringify({ flowcharts: [{ id: "main", name: title || "主线", type: "main", nodes, edges }] }, null, 2);
}

/** 每局主题 CSS（纯函数，便于单测）：主题色变量 + 语言字体栈 + 入口常显标题 + 可访问性/窄屏 */
export function buildThemeCss(
  baseCss: string,
  title: string,
  language: WebgalLanguage,
  accents: AccentPair | null,
): string {
  const base = baseCss.includes(PER_GAME_MARKER) ? baseCss.split(PER_GAME_MARKER)[0] : baseCss;
  const ac = accents?.accent;
  const ac2 = accents?.accent2;
  const vars = ac && ac2
    ? `  --nf-accent: ${hslOf(ac)};\n  --nf-accent-2: ${hslOf(ac2)};\n  --nf-accent-soft: ${hslOf(ac, 0.35)};\n  --nf-glow: ${hslOf(ac, 0.55)};\n`
    : "";
  const font = FONT_STACKS[language] ?? FONT_STACKS.zh_CN;
  const rootBlock = vars ? `:root {\n${vars}}\n` : "";
  const enterText = ENTER_TEXTS[language] ?? ENTER_TEXTS.zh_CN;
  const cjkEnter = !/^(en|ko)$/.test(language);
  return base + `
${PER_GAME_MARKER}
${rootBlock}/* 语言适配字体栈（UI103）：模板实际注册的字体名为「资源圆体 / 思源宋体 / WebgalUI」。
   旧选择器里的 .text 运行时不存在（文本框 DOM 用 outer/inner 等模板类名），故只注入 html/body
   靠继承覆盖界面文字；对话框字体由引擎设置项 textboxFont（默认「资源圆体」）控制。 */
html, body, .Title_buttonList { font-family: ${font} !important; }
/* 首屏「点击开始」文案按语言注入（UI104）：覆盖模板 userStyleSheet.css 写死的中文 content，
   更晚写入的同优先级规则生效；拉丁/谚文文案收紧字距，避免 CJK 的 0.6em 间距过散。 */
.title-enter-container__center-text > div::after {
  content: "${cssEscape(enterText)}";
  letter-spacing: ${cjkEnter ? "0.6em" : "0.18em"};
  padding-left: ${cjkEnter ? "0.6em" : "0.18em"};
}
/* 入口页常显游戏名（引擎入口页不渲染标题元素，与「点击任意处开始」并列展示） */
.title-enter-container__center-text::before {
  content: "${cssEscape(title)}";
  display: block;
  margin-bottom: 1.2em;
  font-size: 44px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-align: center;
  background: linear-gradient(135deg, #ffffff 0%, #ffffff 45%, var(--nf-accent-2, #c4b5fd) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 6px 28px var(--nf-glow, rgba(139, 92, 246, 0.55)));
}
/* 可访问性：键盘焦点可见 */
:focus-visible { outline: 2px solid var(--nf-accent, #8b5cf6); outline-offset: 2px; }
/* 窄屏：快捷栏只留图标，避免多项文字横向溢出 */
@media (max-width: 900px) {
  ._button_text_rdjpk_23 { display: none; }
}
`;
}

/** 流程图：按实际章节重建节点与连线（模板自带 demo 节点会让流程图/鉴赏跳向不存在的场景） */
async function writeFlowchart(outputDir: string, chapters: ChapterScript[], title: string): Promise<void> {
  try {
    await tauri.writeTextFile(joinPath(outputDir, "game/flowchart.json"), buildFlowchartJson(chapters, title));
  } catch (e) {
    log.warn("project", `流程图生成失败（不影响游戏）：${errMsg(e).slice(0, 100)}`);
  }
}

/** 玩家上手指南（WebGAL 无内置教学；放进输出目录随游戏分发） */
async function writeHowToPlay(outputDir: string, title: string): Promise<void> {
  const text = [
    `《${title}》上手指南`,
    "====================",
    "",
    "· 推进剧情：鼠标点击 / 空格 / 回车",
    "· 打开菜单：Esc（存档、读档、设置、鉴赏室、流程图）",
    "· 快进已读：按住 Ctrl，或菜单中的「快进」",
    "· 自动播放：菜单中的「自动」",
    "· 保存进度：菜单 → 存档（含快速存档 F5 / 快速读档 F7）",
    "· 鉴赏室：标题页或游戏内菜单进入（立绘 / CG / 角色 / 音乐）",
    "",
    "通过本地 HTTP 服务访问：在游戏目录执行 `python -m http.server 8080` 后",
    "浏览器打开 http://localhost:8080/index.html —— 直接双击 index.html（file://）",
    "会因浏览器安全策略导致字体与离线缓存受限。",
    "",
  ].join("\n");
  try {
    await tauri.writeTextFile(joinPath(outputDir, "game/HOW_TO_PLAY.txt"), text);
  } catch {
    /* 指南写入失败不影响游戏 */
  }
}

/** 构建信息（关于页/问题定位）：输出根目录 build.json */
async function writeBuildInfo(outputDir: string, meta: ProjectMeta): Promise<void> {
  try {
    await tauri.writeTextFile(joinPath(outputDir, "build.json"), JSON.stringify(meta, null, 2));
  } catch {
    /* 不影响游戏 */
  }
}

/** PWA 图标尺寸表（与模板 manifest.json 声明一致） */
const PWA_ICON_SIZES: { name: string; size: number; maskable?: boolean }[] = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-192-maskable.png", size: 192, maskable: true },
  { name: "icon-512-maskable.png", size: 512, maskable: true },
  { name: "apple-touch-icon.png", size: 180 },
];

/**
 * 封面 → 各尺寸方形图标（#790）：1920×1080 封面原样改名会让浏览器拒绝作为 PWA 安装图标。
 * 这里按声明尺寸重绘：contain 缩放 + 封面均值底色（不裁掉标题/两侧内容），
 * maskable 额外收到 80% 安全区。非浏览器环境（单测/脚本）返回 null，由调用方回退旧拷贝。
 */
async function buildPwaIcons(coverB64: string, mime: string): Promise<Record<string, string> | null> {
  if (typeof document === "undefined") return null;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("icon source decode failed"));
      el.src = `data:${mime};base64,${coverB64}`;
    });
    // 均值底色：1×1 缩略取像素，作为留白背景（深浅封面都能自然融合）
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext("2d");
    if (!pctx) return null;
    pctx.drawImage(img, 0, 0, 1, 1);
    const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
    const out: Record<string, string> = {};
    for (const { name, size, maskable } of PWA_ICON_SIZES) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, size, size);
      const box = maskable ? size * 0.8 : size;
      const scale = Math.min(box / img.width, box / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      out[name] = canvas.toDataURL("image/png").split(",")[1] ?? "";
    }
    return out;
  } catch {
    return null;
  }
}

/** PWA 名称与图标跟随作品（manifest.json + icons/*）；封面图按声明尺寸裁切成各尺寸图标 */
async function patchManifestAndIcons(outputDir: string, title: string, coverName?: string): Promise<void> {
  try {
    const manifestPath = joinPath(outputDir, "manifest.json");
    const { text } = await tauri.readTextFile(manifestPath);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed.name = title;
    parsed.short_name = title;
    await tauri.writeTextFile(manifestPath, JSON.stringify(parsed, null, 2));
  } catch {
    /* 模板缺 manifest 不影响游戏 */
  }
  if (!coverName) return;
  const src = joinPath(outputDir, "game/background", coverName);
  try {
    const mime = /\.jpe?g$/i.test(coverName) ? "image/jpeg" : /\.webp$/i.test(coverName) ? "image/webp" : "image/png";
    const icons = await buildPwaIcons(await tauri.readFileBase64(src), mime);
    if (icons) {
      await tauri.mkdirAll(joinPath(outputDir, "icons")).catch(() => undefined);
      for (const [name, data] of Object.entries(icons)) {
        if (data) await tauri.writeFileBase64(joinPath(outputDir, "icons", name), data).catch(() => undefined);
      }
      return;
    }
    // 非浏览器环境（单测脚本）：保持旧行为，至少让图标文件存在
    for (const { name } of PWA_ICON_SIZES) {
      await tauri.copyFile(src, joinPath(outputDir, "icons", name)).catch(() => undefined);
    }
  } catch {
    /* 图标替换失败不影响游戏 */
  }
}

async function copyAssets(assets: RenderAssets, outputDir: string): Promise<void> {
  const seen = new Set<string>();
  // 有界并发拷贝：文件彼此独立，串行 IPC 往返在大项目上是组装阶段的最大瓶颈。
  const limiter = new ConcurrencyLimiter(8);
  const copy = async (path: string | undefined, destDir: string): Promise<void> => {
    if (!path) return;
    const name = basename(path);
    const destKey = destDir + name;
    // 去重判断在提交任务前同步完成，保证并发下不重复拷贝
    if (seen.has(destKey)) return;
    seen.add(destKey);
    await limiter.run(async () => {
      try {
        await tauri.copyFile(path, joinPath(destDir, name));
      } catch {
        /* skip missing */
      }
    });
  };

  const bgDir = joinPath(outputDir, "game/background");
  const figureDir = joinPath(outputDir, "game/figure");
  const vocalDir = joinPath(outputDir, "game/vocal");

  const jobs: Array<Promise<void>> = [];
  for (const p of Object.values(assets.bg)) jobs.push(copy(p, bgDir));
  // 图片小说分镜：与背景同目录（WebGAL changeBg 从 game/background 解析）
  for (const p of Object.values(assets.shot ?? {})) jobs.push(copy(p, bgDir));
  for (const p of Object.values(assets.cg)) jobs.push(copy(p, bgDir));
  for (const p of Object.values(assets.figure)) jobs.push(copy(p, figureDir));
  for (const p of Object.values(assets.item)) jobs.push(copy(p, figureDir));
  for (const p of Object.values(assets.vocal)) jobs.push(copy(p, vocalDir));
  await Promise.all(jobs);
}

async function copyDirIfExists(src: string, dst: string): Promise<void> {
  try {
    if (await tauri.pathExists(src)) {
      await tauri.copyDirAll(src, dst);
    }
  } catch {
    /* skip missing */
  }
}

async function detectVideos(outputDir: string): Promise<Record<string, string>> {
  const videoMap: Record<string, string> = {};
  const videoDir = joinPath(outputDir, "game/video");
  try {
    await tauri.mkdirAll(videoDir);
    const entries = await tauri.listDir(videoDir);
    for (const e of entries) {
      if (e.isDir) continue;
      const match = /^video_(.+)\.mp4$/i.exec(e.name);
      if (match) videoMap[match[1]] = e.path;
    }
  } catch {
    /* video 目录不可用 */
  }
  return videoMap;
}

const BGM_RULES: Array<[RegExp, string[]]> = [
  [/battle|war|fight|combat|epic|tense|danger|action|boss|战|斗|激|紧张/i, ["战", "斗", "激昂", "紧张", "危险"]],
  [/calm|peace|piano|ambient|quiet|soft|daily|everyday|gentle|静|平|安|舒缓|日常/i, ["静", "平", "安", "舒缓", "日常", "温柔"]],
  [/sad|sorrow|tear|grief|lonely|melancholy|悲|哀|伤|离别/i, ["悲", "哀", "伤", "离别", "孤独"]],
  [/happy|joy|bright|cheer|light|warm|comedy|fun|欢|轻快|暖|明/i, ["欢", "轻快", "暖", "明", "愉快"]],
  [/mystery|dark|suspense|moon|night|shadow|神秘|悬疑|暗|夜|月/i, ["神秘", "悬疑", "暗", "夜色", "月", "阴森"]],
  [/morning|dawn|sunrise|晨|朝|阳光/i, ["晨", "朝", "阳光", "清晨"]],
];

/** 稳定哈希（同一场景每次组装结果一致，避免重装后 BGM 乱跳） */
function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function detectBgm(
  outputDir: string,
  chapters: ChapterScript[],
): Promise<Record<string, string>> {
  const bgmMap: Record<string, string> = {};
  const bgmDir = joinPath(outputDir, "game/bgm");
  let files: string[] = [];
  try {
    await tauri.mkdirAll(bgmDir);
    const entries = await tauri.listDir(bgmDir);
    files = entries
      .filter((e) => !e.isDir && /\.(mp3|ogg|wav|m4a|opus)$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    /* bgm 目录不可用 */
  }
  if (!files.length) return bgmMap;
  // 氛围分类：文件名按规则分类；场景描述按关键词映射到同一条规则（英文文件名如 battle_theme + 中文描述「战斗」也能对上）
  const fileRule = new Map<string, number>();
  for (const f of files) fileRule.set(f, BGM_RULES.findIndex(([re]) => re.test(f)));

  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      if (!scene.bgm) continue;
      const desc = scene.bgm;
      const want = BGM_RULES.findIndex(([, words]) => words.some((w) => desc.includes(w)));
      let hit: string | undefined;
      if (want >= 0) {
        // 首选与描述同氛围的文件（多首按场景稳定轮换）
        const sameRule = files.filter((f) => fileRule.get(f) === want);
        if (sameRule.length) hit = sameRule[stableHash(scene.id) % sameRule.length];
      }
      if (!hit) {
        // 描述无氛围词或该氛围暂无对应文件：在有分类的文件里稳定轮换，避免全场永远第一首
        const classified = files.filter((f) => (fileRule.get(f) ?? -1) >= 0);
        const pool = classified.length ? classified : files;
        hit = pool[stableHash(scene.id) % pool.length];
      }
      if (hit) bgmMap[scene.id] = joinPath(bgmDir, hit);
    }
  }
  return bgmMap;
}

async function writeVideoPlan(
  outputDir: string,
  chapters: ChapterScript[],
  videos: Record<string, string>,
): Promise<void> {
  const points = chapters.flatMap((c) =>
    c.scenes.flatMap((s) =>
      (s.videoPoints || []).map((vp) => ({
        chapter: c.chapter + 1,
        sceneLocation: s.location,
        ...vp,
        enabled: !!videos[sanitizeId(vp.id)],
      })),
    ),
  );
  if (!points.length) return;

  const lines: string[] = [
    "NovelForge 视频推荐清单",
    "======================",
    "以下位置适合插入视频演出（AI 推荐，是否生成由你决定）：",
    "在即梦 / 可灵 / 海螺 等平台用下方「视频提示词」生成视频，",
    "将 mp4 命名为 video_<id>.mp4 放入 game/video/ 文件夹，",
    "重新生成项目（或在预览页刷新）后会自动启用视频演出。",
    "",
  ];
  for (const p of points) {
    lines.push(`第 ${p.chapter} 章（${p.sceneLocation}）${p.enabled ? "【已启用】" : "【未生成】"}`);
    lines.push(`  [${p.id}] ${p.title}`);
    lines.push(`  描述：${p.description}`);
    lines.push(`  提示词：${p.videoPrompt}`);
    lines.push(`  建议时长：${p.durationSecs} 秒`);
    lines.push(`  文件名：video_${sanitizeId(p.id)}.mp4`);
    lines.push("");
  }
  await tauri.writeTextFile(joinPath(outputDir, "video_plan.txt"), lines.join("\n"));
}

/** 向导出的 index.html 注入品牌水印 + 把页面标题替换为作品名（浏览器标签/收藏名称一致） */
async function injectBrandFooter(outputDir: string, title: string): Promise<void> {
  const indexPath = joinPath(outputDir, "index.html");
  try {
    const { text } = await tauri.readTextFile(indexPath);
    const safeTitle = title.replace(/[<>&]/g, " ").trim() || "WebGAL";
    let next = text.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`);
    if (!next.includes("novelforge-brand")) {
      const footer = brandFooterHtml();
      next = next.includes("</body>") ? next.replace("</body>", `${footer}\n</body>`) : next + footer;
    }
    if (next !== text) await tauri.writeTextFile(indexPath, next);
  } catch {
    /* index.html 缺失或不可写则跳过，不影响游戏本体 */
  }
}

/** 导出说明文本（纯函数，便于单测）：BGM 关键词必须成组，SE 段落整体放在 BGM 列表之后。
 *  旧实现把 SE 说明插在 BGM 列表中间，导致「欢快/神秘」两条 BGM 关键词看起来像 SE 规则（#1114）。 */
export function buildExportGuideText(title: string, outputDir: string): string {
  const lines = [
    `「${title}」导出说明（NovelForge 生成）`,
    "==============================================",
    "",
    `本游戏由 NovelForge（AI 视觉小说工坊）生成 · 官网：${brandUrl()}`,
    "",
    "1) 网页版（手机/PC 浏览器即玩，零成本）",
    "   整个文件夹即完整网页游戏。部署到任意静态托管（GitHub Pages / Vercel / 服务器 / 网盘），",
    "   或直接用浏览器打开 index.html。手机浏览器同样可玩。",
    "",
    `2) PC 端 exe`,
    `   下载 WebGAL Terre 编辑器：https://www.openwebgal.com/zh-cn/download/`,
    `   打开 Terre → 「打开项目」→ 选择目录：${outputDir}`,
    `   （或新建项目指向 game 文件夹）→ 点击「发布游戏」→ 选择 Windows 导出 exe。`,
    "",
    "3) 手机端 APK",
    "   使用官方构建工具：https://github.com/OpenWebGAL/webgal-apk-build-tool",
    "   读取本项目文件夹 + 签名信息一键构建 APK（需 Android SDK）。",
    "",
    "4) 自定义修改",
    "   剧本文件：game/scene/ch*.txt（文本编辑器直接改，保存后预览刷新生效）",
    "   立绘：game/figure/ · 背景：game/background/ · 配音：game/vocal/ · 视频：game/video/",
    "   视频推荐位：见同目录 video_plan.txt",
    "   鉴赏室（立绘换装/表情/缩放、CG 画廊、角色图鉴、BGM 试听）：打开 appreciation.html",
    "   游戏内设置（音量/文本速度/自动播放/跳过/存档管理）：标题界面「选项」/ 游戏中右上角菜单",
    "   BGM：把音乐文件（mp3/ogg/m4a）放入 game/bgm/，文件名含关键词自动按氛围播放：",
    "     战斗氛围 → 文件名含 battle/war/fight（如 battle_theme.mp3）",
    "     宁静氛围 → 文件名含 calm/peace/piano（如 calm_piano.mp3）",
    "     悲伤氛围 → 文件名含 sad/sorrow（如 sad_theme.mp3）",
    "     欢快氛围 → 文件名含 happy/joy/bright（如 happy_theme.mp3）",
    "     神秘氛围 → 文件名含 mystery/dark/moon（如 mystery_theme.mp3）",
    "   环境音效（SE）：内置雨/雷/风/战斗/门/脚步/挥剑/张力音效已放入 game/vocal/（se_*.wav），按场景氛围自动播放；",
    "     用同名文件（如 se_rain.wav）替换可自定义音效；不需要可在 vocal 里删除对应文件",
    "",
    "注意：发布时须保留 WebGAL 版权声明（MPL-2.0），游戏本身版权归你所有。",
  ];
  return lines.join("\n");
}

async function writeExportGuide(outputDir: string, title: string): Promise<void> {
  await tauri.writeTextFile(joinPath(outputDir, "导出说明.txt"), buildExportGuideText(title, outputDir));
}

/** 标题稳定哈希（FNV-1a + murmur3 收尾）：同一标题每次一致，不同标题高概率分散。
 *  与 detectBgm 的 stableHash 分开命名，避免语义混淆。 */
function titleHash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Game_key 派生（#1105）：WebGAL 用它命名存档（`${gameKey}-saves`）与已读记录。
 * 旧实现对标题做 ASCII 清洗后截 8 位：纯中文标题清洗结果为空 → 所有中文作品得到同一个 key，
 * 同源预览时「继续游戏/跳过已读」跨作品串档；前 8 位字母数字相同的标题也会碰撞。
 * 现在 = 可读 ASCII 前缀（4 位，不足补 x，纯中文用 nov2）+ 标题哈希（基 36，4 位），
 * 同一标题稳定、不同标题分散，且始终是 8 位字母数字（符合导出页 6-10 位校验）。
 */
export function gameKeyFor(title: string): string {
  const raw = (title || "").trim();
  const ascii = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  // 短标题（如 "a"）前缀不足 4 位时补 x：不补会导致 key 短于 6 位，被导出页校验拒绝（单测回归）
  const prefix = (ascii.slice(0, 4) || "nov2").padEnd(4, "x");
  const hash = (titleHash32(raw) % 36 ** 4).toString(36).padStart(4, "0");
  return (prefix + hash).slice(0, 8);
}
