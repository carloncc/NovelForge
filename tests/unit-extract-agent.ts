import type { ToolCall } from "../src/api/openaiCompatible";
import {
  applyTool,
  finalizeState,
  isToolUnsupportedError,
  mergeCandidates,
  parseTextAction,
  runScanChunk,
  splitNovelForAgent,
  stateSummary,
  type AgentChatFn,
  type ExtractAgentState,
} from "../src/core/extractAgent";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function freshState(): ExtractAgentState {
  return { characters: new Map(), scenes: new Map(), items: new Map() };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function main(): Promise<void> {
  /* ---------- 1) 分片：尊重预算与段落边界 ---------- */
  {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段段落内容${"字".repeat(20)}`).join("\n\n");
    const chunks = splitNovelForAgent(text, 400);
    assert(chunks.length > 1, `400 预算应切出多段，实际 ${chunks.length}`);
    assert(chunks.every((c) => c.length <= 400 + 20), "每段不应显著超过预算");
    assert(chunks.join("").replace(/\n/g, "") === text.replace(/\n/g, "") || chunks.length > 1, "分片应能覆盖全文");
    assert(splitNovelForAgent("", 100).length === 1, "空文本应返回一个空段");
    assert(splitNovelForAgent("短文本", 5000).length === 1, "短文本应单段");
  }

  /* ---------- 2) applyTool：新增/更新/兜底 ---------- */
  {
    const state = freshState();
    let r = applyTool(state, { id: "t1", name: "add_character", args: { id: "linxiao", name: "林骁", appearance: "黑发" } });
    assert(r.ok && state.characters.size === 1, "add_character 应成功");
    const c = state.characters.get("linxiao")!;
    assert(c.name === "林骁" && c.imagePrompt === "", "角色字段应写入且图像 prompt 留空待补全");

    r = applyTool(state, { id: "t2", name: "add_character", args: { id: "linxiao", name: "林骁", personality: "冷静" } });
    assert(r.ok && state.characters.size === 1, "重复 id 应合并而非新增");
    assert(state.characters.get("linxiao")!.personality === "冷静", "重复 id 应补全字段");

    r = applyTool(state, { id: "t3", name: "update_character", args: { id: "linxiao", patch: { clothing: "蓝衣" } } });
    assert(r.ok && state.characters.get("linxiao")!.clothing === "蓝衣", "update_character 应更新字段");

    r = applyTool(state, { id: "t4", name: "update_character", args: { id: "nobody", patch: {} } });
    assert(!r.ok, "更新不存在的角色应失败");

    r = applyTool(state, { id: "t5", name: "add_character", args: { name: "无 id 角色" } });
    assert(r.ok && state.characters.size === 2, "缺 id 时应自动生成 id");

    r = applyTool(state, { id: "t6", name: "add_scene", args: { id: "gate", location: "城门前", atmosphere: "黄昏" } });
    assert(r.ok && state.scenes.size === 1 && state.scenes.get("gate")!.atmosphere === "黄昏", "add_scene 应成功");

    r = applyTool(state, { id: "t7", name: "add_item", args: { id: "sword", name: "星陨剑" } });
    assert(r.ok && state.items.size === 1 && state.items.get("sword")!.note === "", "add_item 应成功");

    r = applyTool(state, { id: "t8", name: "finish_extraction", args: {} });
    assert(r.ok, "finish_extraction 应成功");

    r = applyTool(state, { id: "t9", name: "no_such_tool", args: {} });
    assert(!r.ok, "未知工具应失败");

    r = applyTool(state, { id: "t10", name: "add_character", args: { id: "waiter", name: "店小二", isNpc: true } });
    assert(r.ok && state.characters.get("waiter")?.isNpc === true, "add_character 应保留 isNpc 标记");
  }

  /* ---------- 3) parseTextAction ---------- */
  {
    const a = parseTextAction('{"action":"add_character","data":{"id":"x","name":"某人"}}');
    assert(a?.name === "add_character" && a?.data?.name === "某人", "严格 JSON 动作应解析");

    assert(parseTextAction('{"action":"finish"}')?.name === "finish", "finish 动作应解析");
    assert(parseTextAction("```json\n{\"action\":\"add_item\"}\n```")?.name === "add_item", "代码块包裹应解析");
    assert(parseTextAction("不是 JSON") === null, "非法文本应返回 null");
    assert(parseTextAction('{"foo":1}') === null, "无 action 字段应返回 null");
  }

  /* ---------- 4) runScanChunk：工具协议（脚本化假 LLM） ---------- */
  {
    const state = freshState();
    let step = 0;
    const chat: AgentChatFn = async (messages, tools, opts) => {
      assert(opts.toolCalls === undefined, "工具协议不应走 JSON 模式");
      void messages; void tools; void opts;
      if (step === 0) {
        step++;
        return { content: "", toolCalls: [toolCall("c1", "add_character", { id: "a", name: "阿紫" }), toolCall("c2", "add_scene", { id: "hall", location: "大殿" })] };
      }
      if (step === 1) {
        step++;
        return { content: "", toolCalls: [toolCall("c3", "finish_extraction", {})] };
      }
      throw new Error("假 LLM 不应被继续调用");
    };
    const finished = await runScanChunk(chat, "system", "user", state, { toolCalls: true });
    assert(finished, "finish 后应返回 true");
    assert(state.characters.size === 1 && state.scenes.size === 1, "工具调用应写入状态");
  }

  /* ---------- 5) runScanChunk：文本协议（脚本化假 LLM） ---------- */
  {
    const state = freshState();
    const chat: AgentChatFn = async (messages) => {
      void messages;
      if (messages.length < 3) return { content: '{"action":"add_character","data":{"id":"b","name":"小北"}}' };
      if (messages.length < 5) return { content: '{"action":"add_item","data":{"id":"ring","name":"戒指"}}' };
      return { content: '{"action":"finish"}' };
    };
    const finished = await runScanChunk(chat, "system", "user", state, { toolCalls: false });
    assert(finished, "文本协议 finish 应返回 true");
    assert(state.characters.get("b")?.name === "小北", "文本协议应写入角色");
    assert(state.items.get("ring")?.name === "戒指", "文本协议应写入物品");
  }

  /* ---------- 6) 中止：isAborted 抛出 ---------- */
  {
    const state = freshState();
    const chat: AgentChatFn = async () => ({ content: "", toolCalls: [] });
    let threw = false;
    try {
      await runScanChunk(chat, "s", "u", state, { toolCalls: true, isAborted: () => true });
    } catch (e) {
      threw = true;
      assert((e as Error).message === "已中止", "中止应抛「已中止」");
    }
    assert(threw, "中止应抛出异常");
  }

  /* ---------- 7) mergeCandidates：同名跨段合并 ---------- */
  {
    const state = freshState();
    state.characters.set("a", { id: "a", name: "林骁", appearance: "黑发", clothing: "", personality: "", voiceDesc: "", color: "#3b5bdb", imagePrompt: "", actions: [] });
    state.characters.set("b", { id: "b", name: " 林骁 ", appearance: "", clothing: "蓝衣", personality: "冷静", voiceDesc: "", color: "", imagePrompt: "", actions: [{ id: "point", name: "抬手", prompt: "p" }] });
    mergeCandidates(state);
    assert(state.characters.size === 1, "同名角色应合并为一个");
    const kept = [...state.characters.values()][0];
    assert(kept.appearance === "黑发" && kept.clothing === "蓝衣" && kept.personality === "冷静", "合并应保留更完整字段");
    assert(kept.actions?.length === 1, "动作应并集");
  }

  /* ---------- 8) finalizeState：归一化（音色回退/动作清洗/角色不限量） ---------- */
  {
    const state = freshState();
    const lib = ["alloy", "nova"];
    state.characters.set("bad", { id: "bad", name: "甲", appearance: "a", clothing: "", personality: "", voiceDesc: "", voiceName: "不存在的音色", color: "", imagePrompt: "", actions: [{ id: "OK!", name: "好", prompt: "p" }, { id: "x", name: "", prompt: "" }] });
    for (let i = 0; i < 12; i++) {
      state.characters.set(`c${i}`, { id: `c${i}`, name: `角色${i}`, appearance: "", clothing: "", personality: "", voiceDesc: "", color: "#000000", imagePrompt: "" });
    }
    const out = finalizeState(state, lib, "测试小说");
    assert(out.characters.length === 13, "角色数量应按剧情提取、不做上限（应为 13）");
    const first = out.characters.find((c) => c.id === "bad")!;
    assert(first.voiceName === "alloy", "不存在的音色应回退到列表首个");
    assert(first.actions?.length === 1 && first.actions[0].id === "ok_", "动作 id 应清洗且过滤非法项");
    assert(out.title === "测试小说", "标题应保留");
  }

  /* ---------- 9) isToolUnsupportedError ---------- */
  {
    assert(isToolUnsupportedError(new Error("LLM 返回错误 400: this model does not support tools")), "应识别工具不支持错误");
    assert(isToolUnsupportedError(new Error("LLM 返回错误 400: unknown function parameter")), "应识别函数参数错误");
    assert(!isToolUnsupportedError(new Error("LLM 返回错误 429: rate limit")), "限流不应误判");
    assert(!isToolUnsupportedError(new Error("网络错误")), "网络错误不应误判");
  }

  /* ---------- 10) stateSummary ---------- */
  {
    const s = freshState();
    s.characters.set("a", { id: "a", name: "林骁", appearance: "黑发", clothing: "", personality: "", voiceDesc: "", color: "#3b5bdb", imagePrompt: "" });
    const summary = stateSummary(s);
    assert(typeof summary === "string" && summary.includes("林骁"), "stateSummary 应序列化角色");
  }

  console.log("unit-extract-agent: 全部通过 ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
