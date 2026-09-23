import { lintProject } from "../src/core/lint";
import { tauri } from "../src/utils/tauri";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const DIR = (await mkdtemp(join(tmpdir(), "novelforge-p2-lint-"))).replace(/\\/g, "/");
  await tauri.removePath(DIR).catch(() => {});
  for (const d of ["game/scene", "game/background", "game/figure", "game/vocal", "game/bgm", "game/video", "game"]) {
    await tauri.mkdirAll(`${DIR}/${d}`);
  }

  // 正常 start + ch1（changeScene 指向不存在的文件）+ ch2（悬空 jumpLabel，末章缺 end）
  await tauri.writeTextFile(`${DIR}/game/scene/start.txt`, `; 测试\nchangeScene:ch1.txt;`);
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch1.txt`,
    [`label:ch1_第一章;`, `:开场旁白;`, `changeScene:ch99.txt;`].join("\n"),
  );
  await tauri.writeTextFile(
    `${DIR}/game/scene/ch2.txt`,
    [
      `label:ch2_第二章;`,
      `label:ch2_a;`,
      `label:ch2_b;`,
      `:第二章旁白;`,
      `choose:继续:ch2_a|离开:ch2_b;`,
      `jumpLabel:missing_label;`,
    ].join("\n"),
  );
  // 流程图含坏节点；config 引用缺失的标题曲与封面
  await tauri.writeTextFile(
    `${DIR}/game/flowchart.json`,
    JSON.stringify({
      flowcharts: [
        {
          id: "main",
          name: "t",
          type: "main",
          nodes: [
            { id: "start", type: "root", position: { x: 0, y: 0 }, data: { label: "开始", sceneName: "start.txt" } },
            { id: "ch1", type: "chapter", position: { x: 0, y: 0 }, data: { label: "ch1", sceneName: "ch1.txt" } },
            { id: "bad", type: "chapter", position: { x: 0, y: 0 }, data: { label: "bad", sceneName: "ch99.txt" } },
          ],
          edges: [],
        },
      ],
    }),
  );
  await tauri.writeTextFile(
    `${DIR}/game/config.txt`,
    [`Game_name:测试;`, `Game_key:testkey1;`, `Title_bgm:gone.mp3;`, `Title_img:gone.png;`].join("\n"),
  );

  const report = await lintProject(DIR);
  const errs = report.errors.map((e) => `${e.scope} ${e.message}`).join("\n");
  assert(errs.includes("ch99.txt") && errs.includes("changeScene"), `应检出 changeScene 坏链，实际:\n${errs}`);
  assert(errs.includes("missing_label"), `应检出悬空 jumpLabel，实际:\n${errs}`);
  assert(errs.includes("flowchart.json") && errs.includes("ch99.txt"), `应检出流程图坏节点，实际:\n${errs}`);
  assert(errs.includes("标题曲") && errs.includes("gone.mp3"), `应检出标题曲缺失，实际:\n${errs}`);
  assert(errs.includes("Title_img") && errs.includes("gone.png"), `应检出封面缺失，实际:\n${errs}`);
  // 合法 choose 不应误报
  assert(!report.errors.some((e) => e.message.includes("ch2_a")), "合法 choose 目标不应报错");
  // 末章缺 end 应告警（非末章有 changeScene 则不告警断链）
  assert(report.warnings.some((w) => w.message.includes("缺少 end")), "末章缺 end 应告警");

  // start.txt 无 changeScene → 黑屏包应报错
  await tauri.writeTextFile(`${DIR}/game/scene/start.txt`, `; 空启动\n:只有注释般的旁白;`);
  const report2 = await lintProject(DIR);
  assert(
    report2.errors.some((e) => e.scope.includes("start.txt")),
    "无 changeScene 的 start.txt 应报错（黑屏包）",
  );

  console.log("=== P2 跳转链/标题曲检查回归测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
