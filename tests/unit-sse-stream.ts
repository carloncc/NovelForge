/**
 * SSE 增量解析（剧本路径「已生成 N 字」进度）：正常多 chunk、跨 chunk 半行、keep-alive 注释、
 * [DONE]、usage 块、非 SSE 回退、reasoning_content 计数。
 */
import { initialSseState, parseSseChunks, type SseStreamState } from "../src/api/openaiCompatible";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function feed(state: SseStreamState, chunks: string[]): SseStreamState {
  for (const chunk of chunks) state = parseSseChunks(state, chunk);
  return state;
}

/* ---------- 正常多 chunk：逐段累积正文与字符数 ---------- */
{
  const state = feed(initialSseState(), [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，"}}],"id":"x"}\n\n',
  ]);
  assert(state.sawData, "应识别为 SSE");
  assert(state.content === "你好，", `正文累积错误: ${state.content}`);
  assert(state.content.length === 3, "字符数应等于正文长度");
  assert(!state.done, "未收到 [DONE] 不应置位");
}

/* ---------- 跨 chunk 半行：保留到下次拼接 ---------- */
{
  const line = 'data: {"choices":[{"delta":{"content":"跨块"}}]}\n\n';
  const mid = Math.floor(line.length / 2);
  const state = feed(initialSseState(), [line.slice(0, mid), line.slice(mid)]);
  assert(state.content === "跨块", `半行拼接后应完整解析: ${state.content}`);
  assert(state.pending === "", "完整行解析后不应残留");
}

/* ---------- keep-alive 注释与空行：忽略且不误判 SSE ---------- */
{
  const before = feed(initialSseState(), [": ping\n\n"]);
  assert(!before.sawData, "注释行不得判为 SSE 数据");
  assert(before.content === "", "注释行不应累积内容");
  const after = feed(before, ['data: {"choices":[{"delta":{"content":"甲"}}]}\n\n']);
  assert(after.sawData && after.content === "甲", "注释后正常事件仍要解析");
}

/* ---------- [DONE] ---------- */
{
  const state = feed(initialSseState(), [
    'data: {"choices":[{"delta":{"content":"完"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert(state.done, "[DONE] 应置位");
  assert(state.content === "完", "[DONE] 不应影响已累积正文");
}

/* ---------- usage 块（include_usage：choices 为空，仅带 usage） ---------- */
{
  const state = feed(initialSseState(), [
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"completion_tokens_details":{"reasoning_tokens":7}}}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert(state.promptTokens === 11, "prompt_tokens 未取到");
  assert(state.completionTokens === 22, "completion_tokens 未取到");
  assert(state.reasoningTokens === 7, "reasoning_tokens 未取到");
}

/* ---------- 非 SSE 回退：整包 JSON 不含 data: 行 ---------- */
{
  const body = JSON.stringify({
    choices: [{ message: { content: "整包" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const state = feed(initialSseState(), [body.slice(0, 10), body.slice(10)]);
  assert(!state.sawData, "非 SSE 响应不得判为 SSE（调用方回退 JSON 解析）");
  assert(state.content === "", "非 SSE 不累积正文");
}

/* ---------- reasoning_content 计数与 finish_reason ---------- */
{
  const state = feed(initialSseState(), [
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"了想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}\n\n',
  ]);
  assert(state.reasoning === "想了想", `思考累积错误: ${state.reasoning}`);
  assert(state.reasoning.length === 3, "思考字符数错误");
  assert(state.content === "答案", "正文累积错误");
  assert(state.finishReason === "stop", "finish_reason 未取到");
}

/* ---------- \r\n 行尾 / data: 无空格 / 同 chunk 多事件 / 行内拼接 JSON ---------- */
{
  const state = feed(initialSseState(), [
    'data:{"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"B"}}]}\ndata: {"choices":[{"delta":{"content":"C"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"D"}}]}{"choices":[{"delta":{"content":"E"}}]}\n\n',
  ]);
  assert(state.content === "ABCDE", `多事件同 chunk/行内拼接解析错误: ${state.content}`);
}

/* ---------- \r 恰好落在 chunk 末尾（CRLF 被拆开）：留到下次再解析 ---------- */
{
  const state = feed(initialSseState(), ['data: {"choices":[{"delta":{"content":"尾"}}]}\r', "\n\r\n"]);
  assert(state.content === "尾", "CRLF 跨 chunk 拆分后应正常解析");
}

/* ---------- 输入状态不被就地修改（纯函数契约） ---------- */
{
  const before = initialSseState();
  const after = parseSseChunks(before, 'data: {"choices":[{"delta":{"content":"z"}}]}\n\n');
  assert(before.content === "" && before.sawData === false, "不得就地修改入参状态");
  assert(after.content === "z" && after.sawData, "应返回新状态");
}

console.log("SSE 流式解析测试通过");
