import { ensureUniqueSceneIds } from "../src/core/pipeline";
import type { ChapterScript } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function makeScene(id: string): ChapterScript["scenes"][number] {
  return {
    id,
    location: "x",
    atmosphere: "",
    time: "",
    bgPrompt: "",
    itemEvents: [],
    lines: [{ type: "narration", text: "旁白" }],
    figures: [],
  };
}

function main(): void {
  // 重复 id 去重：s1, s1, s1 → s1, s1_2, s1_3
  const script: ChapterScript = {
    chapter: 0,
    title: "第一章",
    scenes: [makeScene("s1"), makeScene("s1"), makeScene("s1"), makeScene("s2"), makeScene("s1")],
  };
  ensureUniqueSceneIds(script);
  const ids = script.scenes.map((s) => s.id);
  assert(ids[0] === "s1" && ids[1] === "s1_2" && ids[2] === "s1_3" && ids[3] === "s2" && ids[4] === "s1_4", `去重结果异常: ${ids.join(",")}`);

  // 幂等：再次运行不改变结果
  ensureUniqueSceneIds(script);
  const ids2 = script.scenes.map((s) => s.id);
  assert(ids2.join(",") === ids.join(","), "去重应幂等");

  // 空场景数组安全
  ensureUniqueSceneIds({ chapter: 1, title: "x", scenes: [] });

  // 已有后缀的 id 不应被重复处理
  const script2: ChapterScript = { chapter: 0, title: "t", scenes: [makeScene("s1_2"), makeScene("s1_2")] };
  ensureUniqueSceneIds(script2);
  assert(script2.scenes[0].id === "s1_2" && script2.scenes[1].id === "s1_2_2", "已带后缀 id 处理异常");

  console.log("=== 场景 id 去重测试通过 ===");
}
main();
