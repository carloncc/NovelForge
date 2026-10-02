import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { syncDocumentLocale } from "./i18n";

// #1477：挂载前先落一次语言。index.html 里静态写着 lang="zh-CN" 与中文标题，
// 只靠挂载后设置会让首帧被当作中文（字体回退、拼写检查、读屏语言都用错），
// 且窗口标题在 en/ja/ko 下永远停在中文。
syncDocumentLocale();

createApp(App).mount("#app");
