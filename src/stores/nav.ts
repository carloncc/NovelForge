import { ref } from "vue";

/** 页面路由（App.vue 侧边栏与页面内「去某处」动作共用同一来源） */
export type PageId = "import" | "config" | "generate" | "imageStory" | "preview" | "export";

export const currentPage = ref<PageId>("import");

export function goPage(id: PageId): void {
  currentPage.value = id;
  try {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  } catch {
    /* 忽略 */
  }
}
