import { detectSe, renderChapter } from "../src/core/render";
import { buildExportGuideText, compareGalleryFile } from "../src/core/project";
import { classifyMaterial } from "../src/utils/materials";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChapterScript } from "../src/core/types";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const readSrc = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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

function main(): void {
  // ---- #1328：detectSe 不再单字误配 ----
  assert(detectSe(scene({ location: "卧室", atmosphere: "温馨夜话", time: "夜晚" })) === null, "纯夜晚温馨戏不应配 tension");
  assert(detectSe(scene({ location: "剑宗大殿", atmosphere: "庄严", time: "白天" })) === null, "剑宗不应配 sword");
  assert(detectSe(scene({ location: "门派议事厅", atmosphere: "商议", time: "白天" })) === null, "门派不应配 door");
  assert(detectSe(scene({ location: "风铃店", atmosphere: "清脆", time: "白天" })) === null, "风铃不应配 wind");
  assert(detectSe(scene({ location: "书房", atmosphere: "逐渐接近真相", time: "白天" })) === null, "接近真相不应配 step");
  assert(detectSe(scene({ location: "小院", atmosphere: "轻轻敲门", time: "白天" })) === "door", "敲门应配 door");
  assert(detectSe(scene({ location: "山道", atmosphere: "拔剑对峙", time: "白天" })) === "sword", "拔剑应配 sword");
  assert(detectSe(scene({ location: "荒原", atmosphere: "寒风呼啸", time: "白天" })) === "wind", "寒风应配 wind");
  assert(detectSe(scene({ location: "卧室", atmosphere: "阴森寂静", time: "白天" })) === "tension", "阴森氛围应配 tension");
  assert(detectSe(scene({ location: "雨夜", atmosphere: "大雨", time: "夜晚" })) === "rain", "大雨仍应配 rain");

  // ---- #1327：[雨,晴,雨] 应输出 2 次 playEffect（此前 C 场景因 lastSe 未复位而静音） ----
  {
    const ch: ChapterScript = {
      chapter: 0,
      title: "测试章",
      scenes: [
        scene({ id: "s1", location: "野外", atmosphere: "大雨倾盆", time: "白天" }),
        scene({ id: "s2", location: "书房", atmosphere: "温馨日常", time: "白天" }),
        scene({ id: "s3", location: "野外", atmosphere: "大雨倾盆", time: "白天" }),
      ],
    };
    const out = renderChapter(
      ch,
      { characters: [], items: [], assets: { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} } },
      1,
    );
    const hits = out.split("\n").filter((l) => l.includes("playEffect:se_rain.wav"));
    assert(hits.length === 2, `[雨,晴,雨] 应输出 2 次雨声，实际 ${hits.length}`);
  }

  // ---- #1373：画廊排序按数字段 ----
  {
    const files = ["shot_ch1_s1_10.png", "shot_ch1_s1_2.png", "bg_s10.png", "bg_s2.png"];
    const sorted = [...files].sort(compareGalleryFile);
    assert(sorted.indexOf("shot_ch1_s1_2.png") < sorted.indexOf("shot_ch1_s1_10.png"), "分镜 s2 应排在 s10 前");
    assert(sorted.indexOf("bg_s2.png") < sorted.indexOf("bg_s10.png"), "背景 s2 应排在 s10 前");
  }

  // ---- #1332：导出说明 BGM 成组、file:// 口径与 HOW_TO_PLAY 一致 ----
  {
    const text = buildExportGuideText("测试书", "/app/exports/测试书");
    const bgmHappy = text.indexOf("欢快氛围");
    const bgmMystery = text.indexOf("神秘氛围");
    const seStart = text.indexOf("环境音效");
    assert(bgmHappy >= 0 && bgmMystery >= 0 && seStart >= 0, "说明应含 BGM 关键词与 SE 段落");
    assert(bgmHappy < seStart && bgmMystery < seStart, "BGM 关键词必须在 SE 段落之前成组");
    assert(!text.includes("手机浏览器同样可玩"), "不应再承诺双击/手机浏览器无条件可玩");
    assert(text.includes("受限") && text.includes("HOW_TO_PLAY"), "应与 HOW_TO_PLAY 一致提示 file:// 受限");
  }

  // ---- 源码回归锚点 + 直接行为断言（classifyMaterial 已移入可 import 模块） ----
  {
    // #1288/#1367 直接行为：剑归物品、大小写不敏感、char 词边界、默认背景
    assert(classifyMaterial("青霜剑.png") === "item", "剑应归物品");
    assert(classifyMaterial("CHAR_hero.PNG") === "character", "大写 CHAR 应归人物");
    assert(classifyMaterial("Hero.png") === "character", "Hero 应归人物");
    assert(classifyMaterial("chart.png") === "background", "chart 不得误归人物");
    assert(classifyMaterial("夜景街道.png") === "background", "无关键词默认背景");
    assert(classifyMaterial("主角-figure.png") === "character", "figure 应归人物");
    const materialsSrc = readSrc("src/utils/materials.ts");
    assert(materialsSrc.includes("剑|sword"), "分类应含「剑」");
    assert(materialsSrc.includes("toLowerCase"), "分类应大小写不敏感");
    assert(materialsSrc.includes("char([^a-z]"), "分类应约束 char 词边界（防 chart 误配）");
    const importPage = readSrc("src/pages/ImportPage.vue");
    assert(importPage.includes("单文件按标题规则初切"), "ImportPage 文案应如实描述单/多文件切章差异");
    assert(importPage.includes("重新导入") && importPage.includes("覆盖当前分章"), "ImportPage 同名重导应有覆盖确认文案");
    assert(importPage.includes('guardRunning(t("修改章节标题"))'), "章节标题编辑应有运行中守卫");
    assert(importPage.includes('guardRunning(t("导入素材"))'), "素材导入应有运行中守卫");
    assert(importPage.includes('guardRunning(t("移除素材"))'), "素材移除应有运行中守卫");
  }
  {
    const exportPage = readSrc("src/pages/ExportPage.vue");
    assert(exportPage.includes("msgTimer"), "ExportPage 消息应有 timer id 管理（#1348）");
    assert(exportPage.includes("settingsDirty") && exportPage.includes("settingsInitial"), "ExportPage 应有脏状态保护（#1346）");
    assert(exportPage.includes("o.uiLanguage = setExportUiLanguage"), "ExportPage 界面语言应只写独立字段（#1320 真拆分）");
    assert(exportPage.includes("浏览器下载目录"), "ExportPage Web 打包日志应指向下载目录（#1350）");
    assert(exportPage.includes("已不存在") && exportPage.includes("回退"), "ExportPage 标题曲应有陈旧快照回退（#1347）");
  }
  {
    const previewPage = readSrc("src/pages/PreviewPage.vue");
    assert(previewPage.includes('url.value = ""'), "PreviewPage 启动失败应清空 url（#1368）");
    assert(previewPage.includes(".catch("), "PreviewPage 卸载停止服务应捕获 rejection（#1368 附带）");
  }
  {
    const html = readSrc("src/gameExtra/appreciation.html");
    assert(html.includes("NovelForge appreciation template v"), "鉴赏室模板应有版本戳（#1375）");
  }

  console.log("=== P2 渲染/组装/页面回归测试通过 ===");
}

main();
