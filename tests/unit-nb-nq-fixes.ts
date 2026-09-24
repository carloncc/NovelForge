/**
 * nb-nQ 收尾批回归单测：
 * - #1427 计数路径非抛出：buildVoiceJobsOrEmpty 空库返回 []（不抛），看板改用非抛出变体
 * - #1409 批准校验英文错误 → t() key 映射（localizeVisualBibleApprovalError）
 * - #1447 服装锚点窄作废：costumeOwnedImageTasks 只圈该服装、与其它服装不相交
 * - #799 剧本用户消息拼 lore（文件锚点 + loreContextForScript 空串语义）
 * - #1296 / #1406 / #1443 / #1445 面板与 store 接线锚点
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  costumeOwnedImageTasks,
  localizeVisualBibleApprovalError,
  partitionInvalidationIds,
} from "../src/core/visualBible";
import { buildVoiceJobsOrEmpty } from "../src/core/voice";
import { isVoiceLibraryEmpty } from "../src/stores/config";
import { loreContextForScript } from "../src/core/cards";
import type { ApiConfig, CharacterCard, ChapterScript } from "../src/core/types";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/* ---------- #1427：空音色库计数路径不抛异常 ---------- */
{
  const emptyCfg = {
    id: "tts",
    name: "tts",
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    model: "m",
    extra: { voiceLibrary: [] },
  } as unknown as ApiConfig;
  const fullCfg = { ...emptyCfg, extra: { voiceLibrary: ["female-shaonv"] } } as unknown as ApiConfig;

  assert(isVoiceLibraryEmpty(emptyCfg), "显式清空 [] 应判空库");
  assert(!isVoiceLibraryEmpty(fullCfg), "有音色不应判空");
  assert(!isVoiceLibraryEmpty(undefined), "undefined 回退默认表，不算空");

  const cards: CharacterCard[] = [
    { id: "alice", name: "爱丽丝", appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" },
  ];
  const chapter: ChapterScript = {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: "城门",
        atmosphere: "",
        time: "",
        bgPrompt: "gate",
        itemEvents: [],
        figures: ["alice"],
        lines: [{ type: "dialogue", characterId: "alice", text: "你好。" }],
      },
    ],
  };

  let threw = false;
  let emptyJobs: unknown[] = [];
  try {
    emptyJobs = buildVoiceJobsOrEmpty(emptyCfg, [chapter], cards);
  } catch {
    threw = true;
  }
  assert(!threw, "空音色库时 buildVoiceJobsOrEmpty 不得抛异常（否则看板 refresh 中断、配音灯不绿）");
  assert(emptyJobs.length === 0, "空库应返回空 job 列表");
  assert(buildVoiceJobsOrEmpty(fullCfg, [chapter], cards).length > 0, "非空库应正常产出 job");
}

/* ---------- #1409：批准校验错误本地化映射 ---------- */
{
  const styleEmpty = localizeVisualBibleApprovalError("Style description is empty");
  assert(styleEmpty.key.includes("风格描述为空"), "空风格描述应映射到中文 key");

  const notAccepted = localizeVisualBibleApprovalError("Character alice has not been accepted");
  assert(notAccepted.key.includes("尚未确认") && notAccepted.params?.id === "alice", "未确认应带角色 id 参数");

  const stale = localizeVisualBibleApprovalError("Visual bible fingerprint is empty or stale; refresh the draft before approval");
  assert(stale.key.includes("刷新指纹"), "stale 文案应提示刷新指纹");

  const missing = localizeVisualBibleApprovalError("Character bob is missing from the visual bible");
  assert(missing.key.includes("缺失") && missing.params?.id === "bob", "缺失应带角色 id");

  const unknown = localizeVisualBibleApprovalError("some unexpected failure");
  assert(unknown.key === "some unexpected failure" && unknown.fallback === "some unexpected failure", "未命中应原样回退");
}

/* ---------- #1447：服装锚点窄作废粒度 ---------- */
{
  const character: CharacterCard = {
    id: "alice",
    name: "Alice",
    appearance: "",
    clothing: "",
    personality: "",
    voiceDesc: "",
    imagePrompt: "alice",
    threeViewPrompt: "alice turnaround",
    color: "#fff",
    costumes: [
      { id: "ct1", name: "礼服", prompt: "dress" },
      { id: "ct2", name: "战斗服", prompt: "armor" },
    ],
    actions: [{ id: "wave", name: "挥手", prompt: "wave" }],
  };
  const c1 = costumeOwnedImageTasks(character, "ct1");
  const c2 = costumeOwnedImageTasks(character, "ct2");
  assert(c1.fileNames.size > 0 && c1.assetIds.has("alice_ct_ct1"), "应圈定 ct1 的资产/文件");
  assert([...c1.fileNames].every((f) => f.includes("_ct_ct1_")), "只应命中 ct1 文件名，不含表情/动作/其它服装");
  assert(![...c1.fileNames].some((f) => f.includes("_act_")), "窄作废不得波及动作立绘");
  const c2Files = new Set(c2.fileNames);
  assert([...c1.fileNames].every((f) => !c2Files.has(f)), "两套服装的作废集合必须不相交");

  const { valid, skipped } = partitionInvalidationIds([character], ["alice", "ghost"]);
  assert(valid.length === 1 && valid[0].id === "alice" && skipped[0] === "ghost", "缺失 id 应跳过而非抛错");
}

/* ---------- #799：lore 空串语义 + 剧本 user 消息接线锚点 ---------- */
{
  assert(loreContextForScript({}) === "", "无 lore 返回空串（不注入）");
  assert(
    loreContextForScript({ lore: [{ id: "m1", title: "盐帮漕运图", kind: "map", content: "运河三闸。" }] }).startsWith("世界观设定卡："),
    "有 lore 应带固定节头",
  );

  const script = read("src/core/script.ts");
  assert(script.includes("import { loreContextForScript } from \"./cards\";"), "script.ts 应导入 loreContextForScript");
  assert(script.includes("const loreSection = loreContextForScript(cards);"), "buildScriptUser 应计算 lore 节");
  assert(script.includes("...(loreSection ? [`\\n${loreSection}`] : [])"), "空串则不拼、非空拼在场景卡之后");
  const scenesIdx = script.indexOf("场景卡：");
  const loreIdx = script.indexOf("...(loreSection ?");
  assert(scenesIdx > 0 && loreIdx > scenesIdx, "lore 节必须位于场景卡之后");
}

/* ---------- 接线锚点：面板 / store / 配置页 / App ---------- */
{
  const panel = read("src/components/VisualBiblePanel.vue");
  assert(panel.includes("localizeVisualBibleApprovalErrors(approvalErrors.value)"), "#1409 面板应本地化 approvalErrors");
  assert(panel.includes("{{ localizedApprovalErrors.join(\"；\") }}"), "#1409 模板应渲染本地化错误");
  assert(panel.includes("refreshFingerprintManually"), "#1406 面板应有「刷新指纹」入口");
  assert(panel.includes("await refreshFingerprint();"), "#1406 改输入路径后应刷新指纹");
  assert(panel.includes("loadVisualBible(outputDir.value)"), "#1443 中止时按磁盘草稿区分文案");
  assert(panel.includes("已发布，但发布后处理失败"), "#1445 面板应识别发布后清理失败为成功态");

  const gen = read("src/stores/generate.ts");
  assert(gen.includes("syncFingerprintAfterCardsSaved"), "#1406 onCardsSaved 应同步视觉守门指纹");
  assert(gen.includes("computeProjectVisualBibleFingerprint(out, bible, novel, cards.characters)"), "#1406 保存卡片后应重算指纹");

  const stage = read("src/composables/useStageStatus.ts");
  assert(stage.includes("buildVoiceJobsOrEmpty(config"), "#1427 看板计数应用非抛出变体");
  assert(!/buildVoiceJobs\(config/.test(stage), "#1427 计数路径不得再调用会抛出的 buildVoiceJobs");

  const config = read("src/pages/ConfigPage.vue");
  assert(config.includes("isPersistOptIn()") && config.includes("setPersistOptIn(on)"), "#1296 复选框应读写 webKeys opt-in");
  assert(config.includes("Web 端持久化密钥（会话内加密存储）"), "#1296 应有 opt-in 复选框文案");
  assert(config.includes("v-if=\"!isTauri()\""), "#1296 复选框仅 Web 端显示");

  const app = read("src/App.vue");
  assert(app.includes("webSecretsMigrationWarning"), "#1296 顶部横幅应透出 Web 密钥迁移警告");
}

console.log("unit-nb-nq-fixes: 全部通过 ✅");
