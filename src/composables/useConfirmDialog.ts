import { reactive, ref } from "vue";
import { t } from "../i18n";

/**
 * 应用级确认弹层（替代 window.confirm）。
 *
 * 为什么必须替换 window.confirm：
 * 1) 无障碍：原生弹层无 role="dialog" / aria-modal / 标题关联，屏幕阅读器读不出上下文，
 *    也不能约束键盘焦点，纯键盘/读屏用户会迷失在背景页（WCAG 2.4.3 焦点顺序）。
 * 2) 一致性：原生弹层无法主题化，与应用视觉割裂；且它会同步阻塞主线程，
 *    在管线运行中弹出会卡住进度刷新（此前「未响应」观感的一部分）。
 * 3) 可测：原生弹层在自动化环境（jsdom/Playwright）里不可断言，无法回归覆盖。
 *
 * 用法：
 *   if (!(await confirmDialog({ title: t("删除该章节？"), message: t("删除后无法恢复。"), tone: "danger" }))) return;
 */

export interface ConfirmOptions {
  /** 标题（必填，作为可访问名称） */
  title: string;
  /** 正文说明 */
  message?: string;
  /** 次要说明：文件名/路径等长文本，展示为代码块风格 */
  detail?: string;
  /** 确认按钮文案，默认「确定」 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelLabel?: string;
  /** 危险操作：确认按钮用危险色，提示不可逆 */
  tone?: "primary" | "danger";
}

export interface PromptOptions extends Omit<ConfirmOptions, "confirmLabel"> {
  /** 输入框占位符 */
  placeholder?: string;
  /** 已有值（编辑场景） */
  initialValue?: string;
  /** 确认按钮文案，默认「确定」 */
  confirmLabel?: string;
}

interface ConfirmState extends Required<Omit<ConfirmOptions, "detail">> {
  detail?: string;
  /** 弹层形态：确认（是/否）还是输入（文本） */
  kind: "confirm" | "prompt";
  placeholder: string;
  inputValue: string;
}

const visible = ref(false);
const options = reactive<ConfirmState>({
  title: "",
  message: "",
  confirmLabel: "",
  cancelLabel: "",
  tone: "primary",
  detail: undefined,
  kind: "confirm",
  placeholder: "",
  inputValue: "",
});

/** 当前挂起请求的 resolve；同一时刻至多一个弹层（串行化，避免并发覆盖状态）。
 * 确认返回 boolean，输入返回 string|null，故泛型化为 unknown 由调用点收窄。 */
let pending: ((value: unknown) => void) | null = null;
/** 等待队列：管线里连点可能同时触发多个确认，串行处理，后到的排队而不是丢弃 */
const queue: { run: () => void }[] = [];

function show(
  next: ConfirmOptions | PromptOptions,
  kind: "confirm" | "prompt",
  resolve: (value: unknown) => void,
): void {
  pending = resolve;
  options.kind = kind;
  options.title = next.title;
  options.message = next.message ?? "";
  options.detail = next.detail;
  options.confirmLabel = next.confirmLabel ?? t("确定");
  options.cancelLabel = next.cancelLabel ?? t("取消");
  options.tone = next.tone ?? "primary";
  options.placeholder = kind === "prompt" ? ((next as PromptOptions).placeholder ?? "") : "";
  options.inputValue = kind === "prompt" ? ((next as PromptOptions).initialValue ?? "") : "";
  visible.value = true;
}

/** 输入框内容变化（供宿主绑定 v-model） */
function setInputValue(value: string): void {
  options.inputValue = value;
}

function close(value: unknown): void {
  if (!visible.value) return;
  visible.value = false;
  const resolve = pending;
  pending = null;
  resolve?.(value);
  const next = queue.shift();
  if (next) next.run();
}

/** 结束当前弹层：确认（true）或取消（false） */
function settle(value: boolean): void {
  close(value);
}

function enqueue(run: () => void): void {
  if (visible.value || pending) {
    queue.push({ run });
    return;
  }
  run();
}

/** 打开确认框；返回 true=确认，false=取消/Esc/点击遮罩 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue(() => show(opts, "confirm", (v) => resolve(v === true)));
  });
}

/**
 * 打开输入弹层；返回去掉首尾空白后的文本，取消/Esc/空输入返回 null。
 *
 * 为什么需要它（#1483）：EditCards 的「导入克隆声音」用 `window.prompt` 取 voice_id，
 * 而 Tauri 在 macOS 上走 WKWebView，**未实现 window.prompt**——调用直接返回 null 且不弹窗，
 * 用户点按钮毫无反应（像坏掉）。原生 prompt 同样无法主题化、无 a11y 语义，这里一并换掉。
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueue(() =>
      show(opts, "prompt", (v) => {
        if (v === false || v === null || v === undefined) {
          resolve(null);
          return;
        }
        const text = String(v).trim();
        resolve(text.length > 0 ? text : null);
      }),
    );
  });
}

/** 供宿主组件使用：状态 + 结束/取消入口 */
export function useConfirmDialog(): {
  visible: typeof visible;
  options: ConfirmState;
  settle: (value: boolean) => void;
  cancel: () => void;
  submitInput: () => void;
  setInputValue: (value: string) => void;
} {
  return {
    visible,
    options,
    settle,
    cancel: () => settle(false),
    /** 输入弹层按「确定」：把当前文本交回 Promise（空文本由 promptDialog 归一为 null） */
    submitInput: () => close(options.inputValue),
    setInputValue,
  };
}

/** 测试/异常恢复用：清空挂起状态（不 resolve 已排队请求之外的语义变更） */
export function resetConfirmDialog(): void {
  visible.value = false;
  pending = null;
  queue.length = 0;
}
