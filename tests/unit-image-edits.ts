/**
 * 表情差分编辑模式（仅 GPT-Image 系）：
 * - 只有 gpt-image / chatgpt-image 家族支持官方编辑端点，其他模型必须走原参考图生图（用户要求）；
 * - 编辑指令必须带"保持不变清单"（只改表情）；
 * - multipart 请求体拼装正确（字段 + 文件 part，字节无损）。
 */
import { buildEditMultipart, supportsImageEdits } from "../src/api/imageEdits";
import { buildImageTasks, expressionEditPrompt } from "../src/core/images";
import type { ChapterScript, ExtractionResult, ImageTask } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) 模型支持判定：仅 GPT-Image 家族 ---------- */
for (const model of [
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2-2026-04-21",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst-2026-09-08",
  "chatgpt-image-latest",
  "GPT-Image-2",
]) {
  assert(supportsImageEdits(model), `应支持编辑端点：${model}`);
}
for (const model of ["", undefined, "dall-e-2", "Qwen/Qwen-Image-Edit-2509", "gemini-3.1-flash-image", "MiniMax image-01", "image-01"]) {
  assert(!supportsImageEdits(model), `应回退旧路径（不支持编辑端点）：${String(model)}`);
}

/* ---------- 2) multipart 拼装 ---------- */
const boundary = "----novelforgeTEST";
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const body = buildEditMultipart(
  boundary,
  { model: "gpt-image-2", prompt: "change only the facial expression to sad", size: "1024x1024", n: "1", output_format: "png" },
  { name: "image", filename: "source.png", mime: "image/png", bytes },
);
const text = new TextDecoder("latin1").decode(body);
assert(text.startsWith(`--${boundary}\r\n`), "multipart 应以第一个 boundary 开始");
assert(text.endsWith(`--${boundary}--\r\n`), "multipart 应以结束 boundary 收尾");
for (const [name, value] of Object.entries({ model: "gpt-image-2", size: "1024x1024", n: "1", output_format: "png" })) {
  assert(text.includes(`name="${name}"\r\n\r\n${value}\r\n`), `缺少字段 ${name}=${value}`);
}
assert(text.includes('name="image"; filename="source.png"'), "文件 part 应带 filename");
assert(text.includes("Content-Type: image/png"), "文件 part 应带 MIME");
assert(text.includes("change only the facial expression"), "prompt 字段应写入正文");
// 图片字节无损：在 body 中定位原始 7 字节序列
let found = false;
for (let i = 0; i + bytes.length <= body.length; i++) {
  if (bytes.every((b, k) => body[i + k] === b)) {
    found = true;
    break;
  }
}
assert(found, "multipart 应原样包含图片字节");

/* ---------- 3) 任务标记：只有表情差分带 editVariant ---------- */
const cards: ExtractionResult = {
  title: "测试",
  characters: [
    {
      id: "alice",
      name: "爱丽丝",
      appearance: "",
      clothing: "",
      personality: "",
      voiceDesc: "",
      imagePrompt: "anime girl",
      color: "#fff",
      emotions: ["happy", "sad"],
      actions: [{ id: "wave", name: "挥手", prompt: "waving" }],
      costumes: [{ id: "suit", name: "西装", prompt: "suit" }],
    },
  ],
  scenes: [],
  items: [],
};
const chapter: ChapterScript = { chapter: 0, title: "第一章", scenes: [{ id: "s1", location: "x", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [], figures: [] }] };
const tasks = buildImageTasks([chapter], cards, { styleAnchor: false });
const normal = tasks.find((t) => t.kind === "figure" && t.id === "alice")!;
const happy = tasks.find((t) => t.kind === "figure" && t.id === "alice_happy")!;
const action = tasks.find((t) => t.kind === "action")!;
assert(!normal.editVariant, "普通立绘不应走编辑模式");
assert(happy.editVariant === "expression", "表情差分应标记 editVariant=expression");
assert(!action.editVariant, "动作立绘不走编辑模式（本轮只做表情）");

/* ---------- 4) 编辑指令包含"保持不变"清单 ---------- */
const prompt = expressionEditPrompt(happy as ImageTask);
assert(/change ONLY the facial expression/i.test(prompt), "编辑指令应限定只改表情");
assert(/keep everything else exactly the same/i.test(prompt), "编辑指令应包含保持不变清单");
assert(/same body pose/i.test(prompt) && /same plain green screen background/i.test(prompt), "保持不变清单应覆盖姿势与绿幕背景");

console.log("=== image edit mode tests passed ===");
