import { parseSelfCheckReply } from "../src/core/selfcheck";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const pass = [
  "符合，人物无畸形，画风统一",
  "符合要求，没有变形",
  "符合，无畸形、无变形、无多余肢体",
  "符合，未见明显变形，比例正常",
  "符合",
  "符合要求，与参考图是同一角色，背景为纯色绿幕",
  "符合，人物完整可见，无畸形，画风与参考图一致",
];
for (const reply of pass) {
  assert(parseSelfCheckReply(reply).ok, `应判通过：${reply}`);
}

const fail = [
  "不符合：人物手部畸形",
  "符合要求，但人物有轻微变形",
  "符合，但无法判断是否与参考图同一角色",
  "符合，画风统一，但畸形明显",
  "符合，只是不是同一角色",
  "不符合",
  "符合，背景不是纯色，看不清细节",
  "无法判断",
];
for (const reply of fail) {
  assert(!parseSelfCheckReply(reply).ok, `应判不通过：${reply}`);
}

assert(parseSelfCheckReply("符合，人物无畸形").reason.length > 0, "reason 应回传原文摘要");

console.log("=== selfcheck reply parsing tests passed ===");
