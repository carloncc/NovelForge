import { ref } from "vue";
import { zhTW } from "./zh-TW";
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";

export type LangCode = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";

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
export function detectSystemLang(): LangCode {
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

export function useI18n() {
  return { t, currentLang, setLang, LANGS };
}
