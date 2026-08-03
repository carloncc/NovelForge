import type { ChapterScript, CharacterCard, ItemCard, SceneJSON } from "./types";

export interface RenderAssets {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
  vocal: Record<string, string>;
  bgm?: Record<string, string>;
}

export interface RenderOptions {
  title: string;
  gameKey: string;
  characters: CharacterCard[];
  items: ItemCard[];
  assets: RenderAssets;
  videos?: Record<string, string>;
  seenCharacters?: Set<string>;
  introCard?: boolean;
  figureEmotions?: boolean;
}

export function sanitizeId(id: string): string {
  const cleaned = (id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unnamed";
}

function esc(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\./g, "\\.")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

function comment(text: string): string {
  return (text || "").replace(/\r?\n/g, " ").slice(0, 80);
}

function sanitizeLabel(text: string): string {
  return (text || "章节").replace(/[\\/:*?"<>|\r\n;]/g, "_").slice(0, 30);
}

function fileName(f: string): string {
  return f.split(/[\\/]/).pop() || f;
}

function renderItemEvent(scene: SceneJSON, idx: number, opts: RenderOptions): string[] {
  const ev = scene.itemEvents[idx];
  if (!ev) return [];
  const item = opts.items.find((i) => i.id === ev.itemId);
  const file = opts.assets.item[ev.itemId];
  const name = comment(item?.name || ev.itemId);
  const desc = esc(ev.description || item?.appearance || "道具出现");
  const safeItemId = sanitizeId(ev.itemId);
  const out: string[] = [];
  out.push(`; ---- 物品演出：${name} ----`);
  if (file) {
    out.push(`changeFigure:${fileName(file)} -id=item_${safeItemId} -next;`);
  }
  out.push(`intro:「${esc(item?.name || ev.itemId)}」|${desc} -hold;`);
  if (file) {
    out.push(`changeFigure:none -id=item_${safeItemId} -next;`);
  }
  return out;
}

export function renderChapter(
  chapter: ChapterScript,
  opts: RenderOptions,
  chapterCount: number,
): string {
  const out: string[] = [];
  out.push(`; ===== 第 ${chapter.chapter + 1} 章 ${comment(chapter.title)} =====`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  // 章节标签：供 WebGAL 流程图（任务/章节选择界面）显示与跳转
  out.push(`label:ch${chapter.chapter + 1}_${sanitizeLabel(chapter.title)};`);
  // 清场：避免上一章节的立绘残留
  out.push(`changeFigure:none -left -next;`);
  out.push(`changeFigure:none -next;`);
  out.push(`changeFigure:none -right -next;`);

  for (const scene of chapter.scenes) {
    out.push("");
    out.push(`; ---- 场景：${comment(scene.location)}（${comment(scene.atmosphere)} ${comment(scene.time)}）----`);

    // BGM：匹配到的音乐文件则播放（无则跳过，不影响流程）
    const bgmFile = opts.assets.bgm?.[scene.id];
    if (bgmFile) {
      out.push(`bgm:${fileName(bgmFile)};`);
    }

    const bgFile = opts.assets.bg[scene.id];
    if (bgFile) {
      out.push(`changeBg:${fileName(bgFile)} -next;`);
    }

    // 视频推荐位：有用户放置的视频文件则播放，否则注释占位（不执行）
    for (const vp of scene.videoPoints || []) {
      const vfile = opts.videos?.[sanitizeId(vp.id)];
      if (vfile) {
        out.push(`; ---- 视频演出：${comment(vp.title)} ----`);
        out.push(`playVideo:${fileName(vfile)};`);
      } else {
        out.push(`; [视频位] ${comment(vp.title)}：${comment(vp.description)}（提示词见 video_plan.txt，把生成的 mp4 命名为 video_${sanitizeId(vp.id)}.mp4 放入 video 文件夹后刷新即启用）`);
      }
    }

    const cgFile = opts.assets.cg[scene.id];
    const cg = scene.cgEvent;
    if (cg && cgFile) {
      out.push(`changeBg:${fileName(cgFile)} -next;`);
      out.push(`unlockCg:${fileName(cgFile)} -name=${esc(cg.title || cg.description || "CG")};`);
      out.push(`:${esc(cg.description || cg.title)};`);
      out.push(`changeBg:${bgFile ? fileName(bgFile) : "none"} -next;`);
    }

    const eventIdxByTrigger = new Map<number, number>();
    scene.itemEvents.forEach((ev, i) => {
      if (!eventIdxByTrigger.has(ev.triggerIndex)) eventIdxByTrigger.set(ev.triggerIndex, i);
    });

    scene.lines.forEach((line, i) => {
      const evIdx = eventIdxByTrigger.get(i);
      if (evIdx !== undefined) {
        out.push(...renderItemEvent(scene, evIdx, opts));
      }

      if (line.type === "dialogue") {
        const char = opts.characters.find((c) => c.id === line.characterId);
        const figureFile = opts.assets.figure[line.characterId];
        // 表情差分：情绪变化时切换对应表情立绘
        let displayFile = figureFile;
        if (opts.figureEmotions !== false && line.emotion && line.emotion !== "normal") {
          displayFile = opts.assets.figure[`${line.characterId}_${line.emotion}`] ?? figureFile;
        }
        const prev = scene.lines[i - 1];
        const isNewSpeaker = !(prev?.type === "dialogue" && prev.characterId === line.characterId);
        if (displayFile && (isNewSpeaker || displayFile !== figureFile)) {
          out.push(`changeFigure:${fileName(displayFile)} -left -next;`);
        }
        // 首次登场资料演出：立绘 + 文本框资料卡（旁白形式，立绘保持可见）
        if (opts.introCard !== false && char && !opts.seenCharacters?.has(line.characterId)) {
          opts.seenCharacters?.add(line.characterId);
          const parts = [`【${esc(char.name)}】`];
          if (char.appearance) parts.push(esc(char.appearance));
          if (char.personality) parts.push(esc(char.personality));
          out.push(`:${parts.join(" ")};`);
        }
        const name = esc(char?.name || line.characterId || "???");
        const vocalKey = `ch${chapter.chapter}_${sanitizeId(scene.id)}_${i}`;
        const vocalFile = opts.assets.vocal[vocalKey];
        const vocalArg = vocalFile ? ` -${fileName(vocalFile)}` : "";
        out.push(`${name}:${esc(line.text)}${vocalArg};`);
      } else if (line.monologue) {
        out.push(`intro:${esc(line.text)} -hold;`);
      } else {
        out.push(`:${esc(line.text)};`);
      }
    });

    const lastEvIdx = eventIdxByTrigger.get(scene.lines.length);
    if (lastEvIdx !== undefined) {
      out.push(...renderItemEvent(scene, lastEvIdx, opts));
    }
  }

  const isLast = chapter.chapter + 1 >= chapterCount;
  if (isLast) {
    out.push("");
    out.push(`end;`);
  } else {
    out.push("");
    out.push(`changeScene:ch${chapter.chapter + 2}.txt;`);
  }

  return out.join("\n");
}

export function renderStart(chapterCount: number, title: string): string {
  const out: string[] = [];
  out.push(`; ${comment(title)}`);
  out.push(`; 由 NovelForge 自动生成`);
  out.push("");
  if (chapterCount > 0) {
    out.push(`changeScene:ch1.txt;`);
  }
  return out.join("\n");
}

function cleanConfigValue(text: string): string {
  return (text || "").replace(/[;\r\n]+/g, " ").trim().slice(0, 60);
}

export function renderConfig(title: string, gameKey: string): string {
  return [
    `Game_name:${cleanConfigValue(title)};`,
    `Game_key:${cleanConfigValue(gameKey)};`,
    `Enable_Appreciation:true;`,
    `Enable_Continue:true;`,
    `Enable_flowchart:true;`,
    `Show_panic:true;`,
    `Default_Language:zh_CN;`,
  ].join("\n");
}
