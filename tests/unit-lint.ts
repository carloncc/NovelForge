import { lintProject } from "../src/core/lint";
import { tauri } from "../src/utils/tauri";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const DIR = (await mkdtemp(join(tmpdir(), "novelforge-lint-test-"))).replace(/\\/g, "/");
  await tauri.removePath(DIR).catch(() => {});
  // 构造项目：正常章节 + 一个引用缺失素材 + 一个坏语法 + 一个空章
  await tauri.mkdirAll(`${DIR}/game/scene`);
  await tauri.mkdirAll(`${DIR}/game/background`);
  await tauri.mkdirAll(`${DIR}/game/figure`);
  await tauri.mkdirAll(`${DIR}/game/vocal`);
  await tauri.mkdirAll(`${DIR}/game/bgm`);
  await tauri.mkdirAll(`${DIR}/game/video`);

  await tauri.writeTextFile(`${DIR}/game/scene/start.txt`, `changeScene:ch1.txt;`);
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch1.txt`,
    [
      `label:ch1_第一章;`,
      `changeBg:none -next;`,
      `changeBg:missing_bg.png -next;`,
      `林澈:你好 -missing_voice.mp3;`,
      `:正常旁白;`,
      `bad syntax line without semicolon`,
      ``,
    ].join("\n"),
  );
  await tauri.writeTextFile(`${DIR}/game/scene/ch2.txt`, `label:ch2_第二章;\nchangeBg:none;`);
  // 演出指令回归：filmMode / setFilter 必须被识别为指令（此前会被当台词且不校验）
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch3.txt`,
    [`label:ch3_第三章;`, `filmMode:true;`, `setFilter:{"oldFilm":0.35} -target=bg-main -next;`, `:旁白;`].join("\n"),
  );

  const report = await lintProject(DIR);

  console.log("errors:", report.errors.length, "warnings:", report.warnings.length);
  for (const e of report.errors) console.log("  ERR:", e.scope, e.message);
  for (const w of report.warnings) console.log("  WARN:", w.scope, w.message);

  // 素材缺失检测（背景 + 配音）
  assert(report.errors.some((e) => e.message.includes("missing_bg.png")), "应检出缺失背景");
  assert(report.errors.some((e) => e.message.includes("missing_voice.mp3")), "应检出缺失配音");
  // 坏语法检测
  assert(report.errors.some((e) => e.message.includes("无法解析")), "应检出坏语法");
  // 空章警告
  assert(report.warnings.some((w) => w.message.includes("没有任何台词")), "应警告空章节");
  // 演出指令识别：filmMode / setFilter 不得报错、不得计入台词
  assert(!report.errors.some((e) => e.scope.includes("ch3.txt")), "filmMode/setFilter 不应报错");
  assert(report.summary.lines === 3, `台词计数应为 3（ch1×2 + ch3×1），实际 ${report.summary.lines}`);

  // 修复后通过
  await tauri.writeFileBase64(`${DIR}/game/background/missing_bg.png`, Buffer.from("fake").toString("base64"));
  await tauri.writeFileBase64(`${DIR}/game/vocal/missing_voice.mp3`, Buffer.from("fake").toString("base64"));
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch1.txt`,
    [
      `label:ch1_第一章;`,
      `changeBg:none -next;`,
      `changeBg:missing_bg.png -next;`,
      `林澈:你好 -missing_voice.mp3;`,
      `:正常旁白;`,
    ].join("\n"),
  );
  const report2 = await lintProject(DIR);
  assert(!report2.errors.some((e) => e.message.includes("missing_")), "修复后不应有缺失素材错误");
  console.log("=== 导出检查（Lint）测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
