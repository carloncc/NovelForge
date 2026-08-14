import type { ChapterScript, ExtractionResult, ProjectMeta } from "./types";
import type { RenderAssets, WebgalLanguage } from "./render";
import { renderChapter, renderConfig, renderStart, sanitizeId } from "./render";
import { tauri, type FsEntry } from "../utils/tauri";
import { basename, joinPath, normalizePath } from "../utils/path";
import { log } from "../utils/logger";

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
  /** 界面语言（默认 zh_CN）；正文语言由翻译阶段决定 */
  language?: WebgalLanguage;
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

  input.log("渲染剧本文件…");
  const chapterCount = input.chapters.length;
  const seenCharacters = new Set<string>();
  const videos = await detectVideos(normalizedOutputDir);
  const bgmMap = input.useBgm === false ? {} : await detectBgm(normalizedOutputDir, input.chapters);
  
  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, "game/scene/start.txt"),
    renderStart(chapterCount, title),
  );
  
  for (const chapter of input.chapters) {
    const txt = renderChapter(chapter, {
      title,
      gameKey,
      characters: input.cards.characters,
      items: input.cards.items,
      assets: { ...input.assets, bgm: bgmMap },
      videos,
      seenCharacters,
      introCard: input.introCard,
      figureEmotions: input.figureEmotions,
      figureActions: input.figureActions,
    }, chapterCount);
    await tauri.writeTextFile(
      joinPath(normalizedOutputDir, `game/scene/ch${chapter.chapter + 1}.txt`),
      txt
    );
  }

  // 标题画面：用第一章的 CG 或首张背景作标题图，BGM 匹配一首宁静的作标题曲（无则省略）
  const titleImg = pickTitleImage(input.assets);
  const titleBgm = pickTitleBgm(bgmMap);

  await tauri.writeTextFile(
    joinPath(normalizedOutputDir, "game/config.txt"),
    renderConfig(title, gameKey, input.language ?? "zh_CN", titleImg, titleBgm),
  );

  input.log("复制素材…");
  await copyAssets(input.assets, normalizedOutputDir);

  await copyBuiltinSe(normalizedOutputDir, input);
  await writeAppreciation(normalizedOutputDir, input);

  await writeVideoPlan(normalizedOutputDir, input.chapters, videos);
  await writeExportGuide(normalizedOutputDir, title);

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

  done(`输出目录 ${normalizedOutputDir}`);
  log.info("project", "项目组装完成", { outputDir: normalizedOutputDir, meta });

  return { gameDir: normalizedOutputDir, meta };
}

/** 内置环境音效（SE）：复制 src/gameExtra/se/*.wav 到 game/vocal/；用户同名文件已存在时跳过（用户素材优先） */
async function copyBuiltinSe(outputDir: string, input: AssembleInput): Promise<void> {
  try {
    const seDir = joinPath(process.cwd(), "src/gameExtra/se");
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

/** 鉴赏室：生成素材清单数据（appreciation-data.js）+ 复制鉴赏页（立绘换装/表情/缩放、CG 画廊、角色图鉴、BGM 试听） */
async function writeAppreciation(outputDir: string, input: AssembleInput): Promise<void> {
  const basename = (p: string) => p.split(/[\\/]/).pop() || p;
  const characters = input.cards.characters.map((c) => ({
    id: c.id,
    name: c.name,
    clothing: c.clothing,
    appearance: c.appearance,
    isNpc: c.isNpc === true,
    costumes: (c.costumes || []).map((ct) => ({ id: ct.id, name: ct.name })),
    emotions: c.emotions,
  }));
  const cgs = [...new Set(Object.values(input.assets.cg))].map((p) => ({
    file: basename(p),
    name: basename(p).replace(/\.(png|jpg|jpeg|webp)$/i, ""),
  }));
  const bgms = [...new Set(Object.values(input.assets.bgm || {}))].map((p) => ({
    file: basename(p),
    name: basename(p).replace(/\.(mp3|ogg|wav|m4a|opus)$/i, ""),
  }));
  const data = { characters, cgs, bgms };
  const js = `window.APPRECIATION_DATA = ${JSON.stringify(data)};\n`;
  try {
    await tauri.writeTextFile(joinPath(outputDir, "appreciation-data.js"), js);
    // 鉴赏页模板随项目分发（与 index.html 平级，浏览器直接打开即可）
    const tpl = joinPath(process.cwd(), "src/gameExtra/appreciation.html");
    await tauri.copyFile(tpl, joinPath(outputDir, "appreciation.html"));
  } catch (e) {
    input.log(`鉴赏室资源写入失败（不影响游戏本体）：${(e as Error).message.slice(0, 80)}`);
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

async function copyAssets(assets: RenderAssets, outputDir: string): Promise<void> {
  const seen = new Set<string>();
  const copy = async (path: string | undefined, destDir: string): Promise<void> => {
    if (!path) return;
    const name = basename(path);
    const destKey = destDir + name;
    if (seen.has(destKey)) return;
    seen.add(destKey);
    try {
      await tauri.copyFile(path, joinPath(destDir, name));
    } catch {
      /* skip missing */
    }
  };

  const bgDir = joinPath(outputDir, "game/background");
  const figureDir = joinPath(outputDir, "game/figure");
  const vocalDir = joinPath(outputDir, "game/vocal");

  for (const p of Object.values(assets.bg)) await copy(p, bgDir);
  for (const p of Object.values(assets.cg)) await copy(p, bgDir);
  for (const p of Object.values(assets.figure)) await copy(p, figureDir);
  for (const p of Object.values(assets.item)) await copy(p, figureDir);
  for (const p of Object.values(assets.vocal)) await copy(p, vocalDir);
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
  [/battle|war|fight|combat|epic/i, ["战", "斗", "激昂", "紧张"]],
  [/calm|peace|piano|ambient/i, ["静", "平", "安", "舒缓"]],
  [/sad|sorrow|tear|grief/i, ["悲", "哀", "伤", "离别"]],
  [/happy|joy|bright|cheer|light|warm/i, ["欢", "轻快", "暖", "明"]],
  [/mystery|dark|suspense|moon/i, ["神秘", "悬疑", "暗", "夜色", "月"]],
  [/morning|dawn|sunrise/i, ["晨", "朝", "阳光"]],
];

function matchBgm(fileName: string, bgmDesc: string): boolean {
  return BGM_RULES.some(([re, words]) => re.test(fileName) && words.some((w) => bgmDesc.includes(w)));
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
  
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      if (!scene.bgm) continue;
      const hit = files.find((f) => matchBgm(f, scene.bgm!));
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

async function writeExportGuide(outputDir: string, title: string): Promise<void> {
  const lines = [
    `「${title}」导出说明（NovelForge 生成）`,
    "==============================================",
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
    "   BGM：把音乐文件（mp3/ogg）放入 game/bgm/，文件名含关键词自动按氛围播放：",
    "     战斗氛围 → 文件名含 battle/war/fight（如 battle_theme.mp3）",
    "     宁静氛围 → 文件名含 calm/peace/piano（如 calm_piano.mp3）",
    "     悲伤氛围 → 文件名含 sad/sorrow（如 sad_theme.mp3）",
    "   环境音效（SE）：内置雨/雷/风/战斗/门/脚步/挥剑/张力音效已放入 game/vocal/（se_*.wav），按场景氛围自动播放；",
    "     用同名文件（如 se_rain.wav）替换可自定义音效；不需要可在 vocal 里删除对应文件",
    "     欢快氛围 → 文件名含 happy/joy/bright（如 happy_theme.mp3）",
    "     神秘氛围 → 文件名含 mystery/dark/moon（如 mystery_theme.mp3）",
    "",
    "注意：发布时须保留 WebGAL 版权声明（MPL-2.0），游戏本身版权归你所有。",
  ];
  await tauri.writeTextFile(joinPath(outputDir, "导出说明.txt"), lines.join("\n"));
}

export function gameKeyFor(title: string): string {
  const key = title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const pad = "a1b2c3d4";
  return (key || "nov2vn") + pad.slice(0, Math.max(0, 8 - (key || "nov2vn").length));
}
