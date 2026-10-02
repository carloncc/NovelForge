import { confirmDialog, promptDialog, resetConfirmDialog, useConfirmDialog } from "../src/composables/useConfirmDialog";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 1) 确认 → resolve(true)，并把状态回落到不可见
  {
    const { visible, settle } = useConfirmDialog();
    const p = confirmDialog({ title: "删除该章？", tone: "danger" });
    assert(visible.value, "调用后弹层应可见（这是替代 window.confirm 的前提）");
    settle(true);
    assert((await p) === true, "确认应 resolve true");
    assert(!visible.value, "结束后弹层应不可见");
  }

  // 2) 取消 → resolve(false)
  {
    const { settle } = useConfirmDialog();
    const p = confirmDialog({ title: "覆盖当前项目？" });
    settle(false);
    assert((await p) === false, "取消应 resolve false");
  }

  // 3) 选项落到状态上：危险态、自定义按钮文案、detail 透传
  {
    const { options, settle } = useConfirmDialog();
    const p = confirmDialog({
      title: "重新生成此书？",
      message: "将覆盖现有产物",
      detail: "D:/out/proj",
      confirmLabel: "继续",
      cancelLabel: "返回",
      tone: "danger",
    });
    assert(options.tone === "danger", "危险操作应保留 danger 色调");
    assert(options.confirmLabel === "继续", "自定义确认文案应生效");
    assert(options.cancelLabel === "返回", "自定义取消文案应生效");
    assert(options.detail === "D:/out/proj", "detail 应透传给弹层");
    settle(true);
    await p;
  }

  // 4) 默认值：未指定时为普通态与「确定/取消」（且必须是已翻译词条，不能漏成 key 原文）
  {
    const { options, settle } = useConfirmDialog();
    const p = confirmDialog({ title: "继续吗？" });
    assert(options.tone === "primary", "默认应为 primary 色调");
    assert(options.confirmLabel.length > 0 && options.cancelLabel.length > 0, "默认按钮文案不能为空");
    settle(false);
    await p;
  }

  // 5) 并发串行化：第二个请求排队而不是覆盖第一个（管线里连点曾导致状态被覆盖、Promise 永不 resolve）
  {
    const { options, settle, visible } = useConfirmDialog();
    const first = confirmDialog({ title: "第一个" });
    const second = confirmDialog({ title: "第二个" });
    assert(options.title === "第一个", "先到者应立刻展示");
    settle(true);
    assert((await first) === true, "第一个应 resolve true");
    // 第一个结束后第二个才顶上（此处 settle 已把队列里的下一项 show 出来）
    assert(visible.value, "队列中的第二个请求应自动展示");
    assert(options.title === "第二个", "第二个请求应顶替展示");
    settle(false);
    assert((await second) === false, "第二个应 resolve false");
    assert(!visible.value, "全部处理完后弹层应关闭");
  }

  // 6) 重复 settle 不应二次消费（幂等）：避免一次点击 resolve 两个 Promise
  {
    const { settle } = useConfirmDialog();
    const p = confirmDialog({ title: "只该结算一次" });
    settle(true);
    settle(false);
    assert((await p) === true, "首次 settle 的结果应保持不变");
  }

  // 7) reset 清空挂起与队列，避免测试/异常恢复时残留
  {
    const { visible } = useConfirmDialog();
    void confirmDialog({ title: "悬挂请求" });
    assert(visible.value, "reset 前应处于可见");
    resetConfirmDialog();
    assert(!visible.value, "reset 后应关闭弹层");
  }

  // 8) 输入弹层（#1483：替代在 Tauri/WKWebView 下不生效的 window.prompt）
  {
    const { options, submitInput, setInputValue } = useConfirmDialog();
    const p = promptDialog({ title: "粘贴 voice_id", placeholder: "xxx", initialValue: "seed" });
    assert(options.kind === "prompt", "promptDialog 应把弹层切到输入形态");
    assert(options.inputValue === "seed", "initialValue 应预填输入框");
    assert(options.placeholder === "xxx", "placeholder 应透传");
    setInputValue("  cloned-voice-1  ");
    submitInput();
    assert((await p) === "cloned-voice-1", "提交应返回去除首尾空白的文本");
  }
  {
    const { settle } = useConfirmDialog();
    const p = promptDialog({ title: "粘贴 voice_id" });
    settle(false);
    assert((await p) === null, "取消输入弹层应 resolve null");
  }
  {
    const { submitInput, setInputValue } = useConfirmDialog();
    const p = promptDialog({ title: "粘贴 voice_id" });
    setInputValue("   ");
    submitInput();
    assert((await p) === null, "空输入应归一为 null（调用方按取消处理）");
  }
  // 9) 确认与输入共用同一队列：混用时互不污染，且确认框仍返回布尔
  {
    const { options, settle, submitInput } = useConfirmDialog();
    const first = confirmDialog({ title: "先确认" });
    const second = promptDialog({ title: "再输入" });
    assert(options.kind === "confirm", "先到的确认框应先生效");
    settle(true);
    assert((await first) === true, "确认框应返回 true");
    assert(options.kind === "prompt", "队列中的输入弹层应在确认结束后接上");
    submitInput();
    assert((await second) === null || typeof (await second) === "string", "输入弹层应正常结算");
  }

  console.log("=== 无障碍确认/输入弹层（替代 window.confirm / window.prompt）测试通过 ===");
}

void main();
