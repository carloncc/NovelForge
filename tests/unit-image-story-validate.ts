/**
 * 分镜数据校验（#807）：缺 prompt / triggerLineIndex 越界 / id 缺失等坏数据不得写入剧本缓存。
 */
import { parseChapterScript } from "../src/core/dataValidation";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function scene(shots: unknown): Record<string, unknown> {
  return {
    id: "s1",
    location: "城门",
    atmosphere: "黄昏",
    time: "傍晚",
    bgPrompt: "gate",
    itemEvents: [],
    lines: [
      { type: "dialogue", characterId: "alice", text: "第一句" },
      { type: "narration", text: "第二句" },
    ],
    figures: [],
    shots,
  };
}

function chapter(sceneObj: Record<string, unknown>): unknown {
  return { chapter: 0, title: "第一章", scenes: [sceneObj] };
}

function expectError(input: unknown, label: string): void {
  let threw = false;
  try {
    parseChapterScript(input);
  } catch {
    threw = true;
  }
  assert(threw, `应判为坏数据：${label}`);
}

// 1) 合法分镜通过
const ok = parseChapterScript(chapter(scene([
  { id: "s1_shot1", prompt: "wide shot", triggerLineIndex: 0, characters: ["alice"], note: "城门" },
  { id: "s1_shot2", prompt: "close shot", triggerLineIndex: 1 },
])));
assert(ok.scenes[0].shots?.length === 2, "合法分镜应保留");

// 2) 缺 prompt / 空白 prompt
expectError(chapter(scene([{ id: "s1_shot1", prompt: "", triggerLineIndex: 0 }])), "空 prompt");
expectError(chapter(scene([{ id: "s1_shot1", prompt: "  ", triggerLineIndex: 0 }])), "纯空白 prompt");
expectError(chapter(scene([{ id: "s1_shot1", triggerLineIndex: 0 }])), "缺 prompt 字段");

// 3) id 缺失/非法
expectError(chapter(scene([{ id: "", prompt: "x", triggerLineIndex: 0 }])), "空 id");
expectError(chapter(scene([{ prompt: "x", triggerLineIndex: 0 }])), "缺 id");

// 4) triggerLineIndex 越界/非整数
expectError(chapter(scene([{ id: "s1_shot1", prompt: "x", triggerLineIndex: 2 }])), "越界（lines 长度 2，最大 1）");
expectError(chapter(scene([{ id: "s1_shot1", prompt: "x", triggerLineIndex: -1 }])), "负数");
expectError(chapter(scene([{ id: "s1_shot1", prompt: "x", triggerLineIndex: 0.5 }])), "非整数");
expectError(chapter(scene([{ id: "s1_shot1", prompt: "x" }])), "缺 triggerLineIndex");

// 5) 非数组
expectError(chapter(scene("not-an-array")), "shots 非数组");

// 6) 无 shots 的旧剧本照常通过（向后兼容）
const legacy = parseChapterScript(chapter({ ...scene(undefined), shots: undefined }));
assert(legacy.scenes[0].shots === undefined, "旧剧本（无 shots）应兼容");

console.log("=== image story validate tests passed ===");
