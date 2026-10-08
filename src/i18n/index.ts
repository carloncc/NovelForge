import { ref } from "vue";
import { zhTW } from "./zh-TW";
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";

type LangCode = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";

export const LANGS: { code: LangCode; label: string }[] = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
];

/** 文案即 key：zh-CN 为基准（t 缺翻译时回退原文） */
const dicts: Record<LangCode, Record<string, string>> = {
  "zh-CN": {},
  "zh-TW": zhTW,
  en,
  ja,
  ko,
};

const storageKey = "novelforge:uiLang";

/** 跟随系统语言（Tauri webview 与浏览器一致） */
function detectSystemLang(): LangCode {
  try {
    const l = (navigator.language ?? "").toLowerCase();
    if (l.startsWith("zh")) return /hant|tw|hk|mo/.test(l) ? "zh-TW" : "zh-CN";
    if (l.startsWith("ja")) return "ja";
    if (l.startsWith("ko")) return "ko";
  } catch {
    /* 无 navigator（SSR/测试）回退 en */
  }
  return "en";
}

function loadStoredLang(): LangCode {
  try {
    const v = localStorage.getItem(storageKey);
    if (v && LANGS.some((l) => l.code === v)) return v as LangCode;
  } catch {
    /* localStorage 不可用 */
  }
  return detectSystemLang();
}

export const currentLang = ref<LangCode>(loadStoredLang());

export function setLang(code: LangCode): void {
  currentLang.value = code;
  try {
    localStorage.setItem(storageKey, code);
  } catch {
    /* 忽略 */
  }
}

/**
 * 日志时间戳按**界面语言**本地化（#1525）。
 *
 * UI15 当初只把界面日志面板（LogPanel / FailedPanel / ImageStoryPage）改成了跟随界面语言，
 * 三处日志导出（落盘 run-*.log、复制到剪贴板、保存诊断日志）仍是 toLocaleTimeString() 的无参形式，
 * 走浏览器/系统默认语言。界面语言与系统语言不一致时（英文界面 + 中文系统，或反过来），
 * 用户复制出去、发给别人的日志时间戳与屏幕上的对不上。
 *
 * 统一收口到这里：谁需要时间戳都走这一个函数，克隆体不会再各走各的。
 */
export function formatLogTime(ms: number): string {
  const lang = currentLang.value;
  return new Date(ms).toLocaleTimeString(lang === "zh-CN" ? "zh-CN" : lang);
}

/** 翻译：key = 中文原文，缺翻译自动回退原文；{name} 占位符插值 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dicts[currentLang.value] ?? {};
  let out: string = dict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return out;
}

/**
 * 把当前语言同步到文档级可访问性/系统集成点：
 * - <html lang>：屏幕阅读器朗读语言、拼写检查、CJK 字体回退都依赖它。
 *   index.html 里静态写着 zh-CN，仅靠挂载后设置会有一段首帧按中文处理。
 * - document.title：窗口标题/任务栏在 en/ja/ko 下此前恒为中文。
 */
export function syncDocumentLocale(): void {
  const code = currentLang.value;
  try {
    document.documentElement.lang = code;
    document.title = t("NovelForge - AI 视觉小说转换工具");
  } catch {
    /* 无 DOM 环境（测试/SSR）忽略 */
  }
}

