<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { confirmDialog } from "../../composables/useConfirmDialog";
import { DEFAULT_BACKGROUND_REUSE } from "../../core/types";
import type { BackgroundReuseMode } from "../../core/types";

/** 全量重跑开关：开启前二次确认，避免误勾后每一次生成都全价计费；取消要还原勾选态 */
async function onSkipCacheChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  if (
    input.checked &&
    !(await confirmDialog({
      title: t("开启「跳过缓存（全量重跑）」后，之后每一次生成/重跑都会忽略缓存全量重生成（全价计费）。确定开启吗？"),
      tone: "primary",
    }))
  ) {
    input.checked = false;
    return;
  }
  projectState.options.skipCache = input.checked;
}

/** #1362：number 输入 min=0 拦不住手动键入的负数；负数会被下游 >0 判定吞成「不限制」/回退默认种子，与显示值不一致。
 *  change 时钳到 >=0，与下游语义（0 = 不限制/自动派生）对齐。纯函数逻辑见 tests/unit-audit-u2-budget-clamp.ts */
function clampNonNegativeInt(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function onBudgetChange(key: "cgPerChapter" | "imageBudgetPerChapter" | "videoPointsPerChapter" | "backgroundsPerLocation", e: Event): void {
  const el = e.target as HTMLInputElement;
  const clamped = clampNonNegativeInt(el.value);
  projectState.options[key] = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}

function onSeedChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  const clamped = clampNonNegativeInt(el.value);
  projectState.options.imageSeed = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}

/** #1580 背景复用口径：改变的是「背景任务清单」（502 个场景实例 → N 张图），
 *  章节灯/看板由 generate.ts 的 watch 自动刷新，这里只落值。
 *  切换口径会换掉全部背景文件名（bg_<sceneId> ↔ bg_<桶>），旧图不会被复用 → 二次确认，
 *  与「跳过缓存」同一套防误触口径（这条真的会重新计费）。 */
const REUSE_MODES: BackgroundReuseMode[] = ["locationTimeWeather", "locationTime", "location", "off"];
function reuseMode(): BackgroundReuseMode {
  const v = projectState.options.backgroundReuse;
  return v && REUSE_MODES.includes(v) ? v : DEFAULT_BACKGROUND_REUSE;
}
async function onReuseChange(e: Event): Promise<void> {
  const el = e.target as HTMLSelectElement;
  const next = REUSE_MODES.includes(el.value as BackgroundReuseMode) ? (el.value as BackgroundReuseMode) : DEFAULT_BACKGROUND_REUSE;
  const prev = reuseMode();
  if (next === prev) return;
  if (
    !(await confirmDialog({
      title: t("切换背景复用口径会改变全部背景图的文件名：已生成的背景会全部判为缺失、按新口径重新生成（计费）。确定切换吗？"),
      message: t("（口径越粗越省：地点×昼夜×天气 ≈ 300 张、地点×昼夜 ≈ 280 张、只按地点 ≈ 200 张、关闭 = 一个场景一张。旧文件不会自动删除，可在「素材」页点「清理无效素材」回收）"),
      tone: "primary",
    }))
  ) {
    el.value = prev;
    return;
  }
  projectState.options.backgroundReuse = next;
}
function reuseModeLabel(mode: BackgroundReuseMode): string {
  switch (mode) {
    case "locationTimeWeather": return t("地点 × 昼夜 × 天气（推荐）");
    case "locationTime": return t("地点 × 昼夜");
    case "location": return t("只按地点（最省）");
    default: return t("关闭：一个场景一张（最贵）");
  }
}

/** 1399：SE 音量。seVolume 未进 GenerationOptions 类型表（白名单外），用可选交集读写；
 *  渲染侧缺省为 35，这里同口径回显，避免未设置时显示空值。 */
type OptionsWithSeVolume = { seVolume?: number };
function getSeVolume(): number {
  const v = (projectState.options as OptionsWithSeVolume).seVolume;
  return typeof v === "number" && Number.isFinite(v) ? v : 35;
}
function onSeVolumeChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  const clamped = Math.min(100, clampNonNegativeInt(el.value));
  (projectState.options as OptionsWithSeVolume).seVolume = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("输出与质量") }}</h3>
      <span class="hint">{{ t("扩展输出、画风一致性与用量上限") }}</span>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("扩展输出") }}</h3>
        <span class="hint">{{ t("由「预设」统一控制，这里可单独覆盖") }}</span>
      </div>
      <div class="opt-grid">
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.useVideoPoints" />
          <span class="opt-text">
            {{ t("视频推荐位") }}
            <span class="hint">{{ t("在剧情点插入视频推荐") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.useBgm !== false" @change="(e: any) => { projectState.options.useBgm = (e.target as HTMLInputElement).checked; }" />
          <span class="opt-text">
            {{ t("BGM 匹配") }}
            <span class="hint">{{ t("扫描项目 bgm 文件夹匹配场景音乐（留空/缺省按开启处理）") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.useSe !== false" @change="(e: any) => { projectState.options.useSe = (e.target as HTMLInputElement).checked; }" />
          <span class="opt-text">
            {{ t("环境音效（SE）") }}
            <span class="hint">{{ t("按场景氛围播放内置雨/雷/风等音效（留空/缺省按开启处理）") }}</span>
          </span>
        </label>
      </div>
      <!-- 1399：SE 音量入口（此前 seVolume 无任何 UI/调用方，恒为 35） -->
      <div v-if="projectState.options.useSe !== false" class="field-grid mt-3">
        <label class="field">
          <span>{{ t("环境音效音量（0-100，默认 35）") }}</span>
          <input type="number" min="0" max="100" :value="getSeVolume()" @change="onSeVolumeChange" />
          <span class="hint">{{ t("仅影响按氛围播放的 SE（雨/雷/风等），不影响 BGM 与配音") }}</span>
        </label>
      </div>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("质量控制") }}</h3>
        <span class="hint">{{ t("画风锚点、自动自检与随机种子") }}</span>
      </div>
      <div class="opt-grid">
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.styleAnchor" />
          <span class="opt-text">
            {{ t("风格锚点（背景/CG 统一画风）") }}
            <span class="hint">{{ t("先生成基准图，再作为背景/CG 的参考图") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.imageSelfCheck" />
          <span class="opt-text">
            {{ t("图像自检（多模态核对，不合格自动重生成）") }}
            <span class="hint">{{ t("会增加费用与耗时") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.skipCache" @change="onSkipCacheChange" />
          <span class="opt-text">
            {{ t("跳过缓存（全量重跑）") }}
            <span class="hint">{{ t("每一次生成都全价计费") }}</span>
          </span>
        </label>
      </div>
      <div class="field-grid mt-3">
        <label class="field">
          <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.imageSeed" @change="onSeedChange" />
          <span class="hint">{{ t("同一种子下画风与角色更稳定一致") }}</span>
        </label>
      </div>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("预算上限") }}</h3>
        <span class="hint">{{ t("超出上限的项直接跳过") }}</span>
      </div>
      <div class="field-grid">
        <label class="field">
          <span>{{ t("每章 CG 数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.cgPerChapter" @change="(e) => onBudgetChange('cgPerChapter', e)" />
          <span class="hint">{{ t("超出上限的 CG 直接跳过") }}</span>
        </label>
        <label class="field">
          <span>{{ t("每章背景数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.imageBudgetPerChapter" @change="(e) => onBudgetChange('imageBudgetPerChapter', e)" />
          <span class="hint">{{ t("仅限制背景图；立绘/物品不受限，CG 用上方单独上限") }}</span>
        </label>
        <label class="field">
          <span>{{ t("同一地点背景上限（每章，0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="3" :disabled="reuseMode() !== 'off'" :value="projectState.options.backgroundsPerLocation" @change="(e) => onBudgetChange('backgroundsPerLocation', e)" />
          <span v-if="reuseMode() !== 'off'" class="hint">{{ t("已开启背景复用，此项不生效（复用已从根上消除「同一间房被画几十次」，继续叠加只会把昼夜/天气差分一起裁掉）；要恢复它请把上方「背景复用」改为关闭") }}</span>
          <span v-else class="hint">{{ t("同一地点在一章内最多出几张背景（默认 3）：LLM 给每个场景实例都写一条独一无二的氛围，实测同一间公寓被画过 79 次；0 = 保留全部氛围图") }}</span>
        </label>
        <label class="field">
          <span>{{ t("背景复用（一张图服务多个场景）") }}</span>
          <select :value="reuseMode()" @change="onReuseChange">
            <option v-for="m in REUSE_MODES" :key="m" :value="m">{{ reuseModeLabel(m) }}</option>
          </select>
          <span class="hint">{{ t("同一「地点 × 昼夜 × 天气」的场景共用一张背景图（VN 常规做法，一个地点 2~4 张：昼/夜/雨）。实测某 30 章项目 502 个场景实例 → 约 300 张；同一间公寓从 24 张降到几张。关闭 = 一个场景实例一张图，由上方「同一地点背景上限」收敛") }}</span>
        </label>
        <label class="field">
          <span>{{ t("每场景视频推荐点数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.videoPointsPerChapter" @change="(e) => onBudgetChange('videoPointsPerChapter', e)" />
          <span class="hint">{{ t("每个场景最多保留该数量，多场景合计可能超出；0 = 不限制") }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.opt-stack {
  align-items: flex-start;
}
.opt-stack input[type="checkbox"] {
  margin-top: 2px;
}
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* 小节标题要比卡片标题低一级：缩小字号并收紧与控件的间距 */
.card-section .card-head {
  margin-bottom: var(--space-3);
}
.card-section .card-head h3 {
  font-size: 13.5px;
}
</style>
