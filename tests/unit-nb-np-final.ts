import { engineSafeFileName, legacySceneVocalKey, renderChapter, sceneVocalKey } from "../src/core/render";
import { buildExportGuideText, extractAssetRefs } from "../src/core/project";
import { splitTranslatedFirstBlock } from "../src/core/translate";
import { splitVocalFileName } from "../src/core/voice";
import type { ChapterScript } from "../src/core/types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const readSrc = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const ASSETS = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };

function scene(over: Record<string, unknown> = {}): ChapterScript["scenes"][number] {
  return {
    id: "s1",
    location: "某地",
    atmosphere: "",
    time: "",
    bgPrompt: "",
    itemEvents: [],
    lines: [{ type: "narration", text: "旁白" }],
    figures: [],
    ...over,
  } as ChapterScript["scenes"][number];
}

function chapter(scenes: ChapterScript["scenes"], over: Partial<ChapterScript> = {}): ChapterScript {
  return { chapter: 0, title: "测试章", scenes, ...over } as ChapterScript;
}

function main(): void {
  // ---- 1396：视频扩展名口径统一（detectVideos 与 render/import/check 一致） ----
  {
    const projectSrc = readSrc("src/core/project.ts");
    assert(projectSrc.includes("(mp4|webm|ogg)"), "detectVideos 应接受 mp4/webm/ogg（与 import/check 一致）");
    assert(!projectSrc.includes("/^video_(.+)\\.mp4$/i"), "不应再只认 mp4");
    // render 的 videos 映射应能把 webm 写成 playVideo 指令
    const out = renderChapter(
      chapter([scene({ id: "s1", videoPoints: [{ id: "vp1", title: "高潮", description: "desc", videoPrompt: "p", durationSecs: 5 }] })]),
      { characters: [], items: [], assets: ASSETS, videos: { vp1: "/x/game/video/video_vp1.webm" } },
      1,
    );
    assert(out.includes("playVideo:video_vp1.webm;"), "webm 视频应生成 playVideo 指令");
  }

  // ---- 1397：文案改为「需重新组装」，不再承诺刷新即启用 ----
  {
    const out = renderChapter(
      chapter([scene({ id: "s1", videoPoints: [{ id: "vp1", title: "高潮", description: "desc", videoPrompt: "p", durationSecs: 5 }] })]),
      { characters: [], items: [], assets: ASSETS },
      1,
    );
    assert(out.includes("重新组装"), "视频位占位应提示重新组装");
    assert(!out.includes("刷新即启用"), "不应再承诺刷新即启用");
    const projectSrc = readSrc("src/core/project.ts");
    assert(!projectSrc.includes("在预览页刷新"), "video_plan 不应再写预览页刷新即启用");
    assert(projectSrc.includes("重新组装生效"), "video_plan 应指到「重新组装生效」");
  }

  // ---- 1399：SE 音量透传（renderChapter 直接生效 + pipeline 有调用方） ----
  {
    const out = renderChapter(
      chapter([scene({ id: "s1", location: "野外", atmosphere: "大雨倾盆" })]),
      { characters: [], items: [], assets: ASSETS, useSe: true, seVolume: 12 },
      1,
    );
    assert(out.includes("playEffect:se_rain.wav -volume=12"), "seVolume 应透传到 playEffect -volume");
    const pipelineSrc = readSrc("src/core/pipeline.ts");
    assert(pipelineSrc.includes("seVolume:"), "pipeline 组装调用应传入 seVolume（不再是死参数）");
  }

  // ---- 1425：重新生成的 tooltip 明示补缺计费 ----
  {
    const src = readSrc("src/components/StageStatusBoard.vue");
    assert(src.includes("补齐会按实际用量计费"), "tooltip 应明示补缺真实计费");
    assert(!src.includes("只补缺失/失败项，不计费"), "不应再宣称补缺不计费");
  }

  // ---- 1428：译本首块标题解析（含无空行、标题：前缀、正文保护） ----
  {
    assert(
      JSON.stringify(splitTranslatedFirstBlock("Chapter One\n\nThe hero woke.", "第一章")) ===
        JSON.stringify({ title: "Chapter One", body: "The hero woke." }),
      "空行标题应被提取",
    );
    assert(
      JSON.stringify(splitTranslatedFirstBlock("Chapter One\nThe hero woke.", "第一章")) ===
        JSON.stringify({ title: "Chapter One", body: "The hero woke." }),
      "无空行的短标题也应被提取并从正文剔除",
    );
    assert(
      JSON.stringify(splitTranslatedFirstBlock("标题：Chapter One\nThe hero woke.", "第一章")) ===
        JSON.stringify({ title: "Chapter One", body: "The hero woke." }),
      "「标题：」前缀应被识别",
    );
    assert(splitTranslatedFirstBlock("It was a long night and the rain kept falling.", "第一章") === null, "单行正文不应被当标题");
    assert(splitTranslatedFirstBlock("This is a full sentence.\nSecond line.", "第一章") === null, "以句末标点结尾的首行不应被当标题");
    assert(splitTranslatedFirstBlock("A fairly long first line that clearly is prose\nbody", "第一章") === null, "无空行且过长的首行应保守当正文");
  }

  // ---- 1451：file:// 说明与探测 ----
  {
    const guide = buildExportGuideText("测试书", "/app/exports/x");
    assert(guide.includes("必须通过 HTTP"), "导出说明应明示必须 HTTP");
    assert(guide.includes("start_game.bat"), "导出说明应指向随包启动脚本");
    assert(!guide.includes("基本可玩"), "不应再承诺双击基本可玩");
    const projectSrc = readSrc("src/core/project.ts");
    assert(projectSrc.includes("writeStartScripts") && projectSrc.includes("start_game.bat"), "应写入随包启动脚本");
    assert(projectSrc.includes("CORS"), "HOW_TO_PLAY 应说明 file:// 失败原因");
    const html = readSrc("src-tauri/templates/webgal/index.html");
    assert(html.includes("无法直接双击打开本游戏"), "模板 index.html 应有 file:// 协议探测提示");
  }

  // ---- 1452：素材文件名映射 + 脚本引用提取 ----
  {
    assert(engineSafeFileName("/a/b/Track | 01;x.mp3") === "Track ｜ 01；x.mp3", "文件名应映射 | 与 ;");
    assert(engineSafeFileName("a/Kalimba - Theme.mp3") === "Kalimba ‑ Theme.mp3", "「空格-连字符」应换成非断连字符");
    const projectSrc = readSrc("src/core/project.ts");
    assert(projectSrc.includes("engineSafeFileName(basename(path))"), "copyAssets 落盘应用同一映射");
    const refs = extractAssetRefs(
      [
        "; comment",
        "changeBg:bg_s1.png -duration=500 -next;",
        "changeBg:none -duration=0 -next;",
        "bgm:Kalimba ‑ Theme.mp3 -enter=1000 -next;",
        "Alice:hi -vocal=v_ch1_s1_ab12_0_x_y.mp3;",
        "playEffect:se_rain.wav -volume=35 -next;",
      ].join("\n"),
    );
    assert(refs.some((r) => r.dir === "background" && r.file === "bg_s1.png"), "应提取 changeBg 引用");
    assert(!refs.some((r) => r.file === "none"), "none 不应计入引用");
    assert(refs.some((r) => r.dir === "bgm" && r.file === "Kalimba ‑ Theme.mp3"), "应提取 bgm 引用");
    assert(refs.some((r) => r.dir === "vocal" && r.file === "v_ch1_s1_ab12_0_x_y.mp3"), "应提取 -vocal 引用");
    assert(refs.some((r) => r.dir === "vocal" && r.file === "se_rain.wav"), "应提取 playEffect 引用");
  }

  // ---- 1459：filmMode 只在真正播放视频的场景开启（氛围改走滤镜） ----
  {
    const tense = renderChapter(
      chapter([scene({ id: "s1", location: "战场", atmosphere: "激烈战斗" })]),
      { characters: [], items: [], assets: ASSETS },
      1,
    );
    assert(!tense.includes("filmMode:true"), "紧张氛围不应再切 filmMode（会换成无名牌/无底板/大字号对话框）");
    assert(tense.includes("godrayFilm"), "紧张氛围应改用 godrayFilm 滤镜");
    const withVideo = renderChapter(
      chapter([scene({ id: "s1", location: "战场", atmosphere: "激烈战斗", videoPoints: [{ id: "vp1", title: "战", description: "d", videoPrompt: "p", durationSecs: 5 }] })]),
      { characters: [], items: [], assets: ASSETS, videos: { vp1: "/x/game/video/video_vp1.mp4" } },
      1,
    );
    assert(withVideo.includes("filmMode:true"), "确实播放视频的场景才开 filmMode（letterbox）");
  }

  // ---- 1462：配音键加哈希防撞名（仅对有损 id）+ 旧键回退 + 内容寻址认领 ----
  {
    // sc_a b 与 sc_a_b 经 sanitizeId 折叠成同一串；旧键相同（撞车），新键必须不同
    assert(legacySceneVocalKey(0, "sc_a b", 0) === legacySceneVocalKey(0, "sc_a_b", 0), "旧键确实会撞（回归锚点）");
    assert(sceneVocalKey(0, "sc_a b", 0) !== sceneVocalKey(0, "sc_a_b", 0), "新配音键应因哈希而区分");
    // 无损失（引擎安全）id 沿用历史键：旧配音文件零迁移、不重配
    assert(sceneVocalKey(0, "s1", 0) === legacySceneVocalKey(0, "s1", 0), "安全 id 应沿用历史键（避免全量重配计费）");
    // 有损 id 的新键与旧键不同，供 render 的 legacy 回退命中旧文件
    assert(sceneVocalKey(0, "sc_a b", 0) !== legacySceneVocalKey(0, "sc_a b", 0), "有损 id 的新键应与旧键不同（用于回退判定）");
    // 内容寻址：fp+hash 与 key 无关，旧文件可被 0 计费认领
    const oldFile = splitVocalFileName("v_ch1_s1_0_dead_beef.mp3");
    const newFile = splitVocalFileName("v_ch1_s1_ab12_0_dead_beef.mp3");
    assert(!!oldFile && !!newFile, "新旧文件名都应可解析");
    assert(`${oldFile!.fp}_${oldFile!.hash}` === `${newFile!.fp}_${newFile!.hash}`, "fp+hash 与 key 无关，旧配音可免费认领");
    assert(newFile!.key === "ch1_s1_ab12_0", "含哈希与序号的键应被正确解析");
  }

  console.log("=== nb-nP 收尾批（1396/1397/1399/1425/1428/1451/1452/1459/1462）测试通过 ===");
}

main();
