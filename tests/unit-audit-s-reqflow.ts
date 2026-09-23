/**
 * ReqFlow batch-s 正确性回归（#1299/#1300/#1308/#1315/#1320/#1333）：
 * 只覆盖白名单内 stores 导出的纯函数；#1309 在禁区无 store 侧改动，不在此覆盖。
 */
import { shouldRejectRun, isStaleRunId, canTransferAssetToRun, resolveCharDisplayName, isSplitConfirmKeyForDir } from "../src/stores/generate";
import { migrateConfigFile, loadConfigFile } from "../src/stores/configMigration";
import {
  hashKeyFragment,
  modelFetchSignature,
  shouldRefetchModels,
  mergeDiscoveredModels,
  isModelEndpointChanged,
  applyDiscoveredModelsSuccess,
  applyDiscoveredModelsFailure,
} from "../src/stores/config";
import {
  normalizeExportUiLanguage,
  coerceTranslationLanguage,
  resolveTranslationLanguageUpdate,
} from "../src/stores/project";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function makeIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

async function main(): Promise<void> {
  // #1299：并发守卫纯函数
  assert(shouldRejectRun({ busy: false, assetBusy: "", queueRunning: false }) === false, "空闲应放行");
  assert(shouldRejectRun({ busy: true, assetBusy: "", queueRunning: false }) === true, "busy 应拒绝");
  assert(shouldRejectRun({ busy: false, assetBusy: "voice:1", queueRunning: false }) === true, "assetBusy 应拒绝");
  assert(shouldRejectRun({ busy: false, assetBusy: "", queueRunning: true }) === true, "队列中外部应拒绝");
  assert(shouldRejectRun({ busy: false, assetBusy: "", queueRunning: true, fromQueue: true }) === false, "队列内部应放行");
  assert(isStaleRunId(1, 2) === true && isStaleRunId(2, 2) === false, "令牌过期判定");

  // #1300：素材→组装交接纯函数（无两锁皆空窗口的前提）
  assert(canTransferAssetToRun({ busy: false, assetBusy: "voice:1", queueRunning: false }) === true, "持有 asset 且空闲应可交接");
  assert(canTransferAssetToRun({ busy: false, assetBusy: "", queueRunning: false }) === false, "无 asset 不交接");
  assert(canTransferAssetToRun({ busy: true, assetBusy: "voice:1", queueRunning: false }) === false, "busy 时不交接");
  assert(canTransferAssetToRun({ busy: false, assetBusy: "voice:1", queueRunning: true }) === false, "队列中不交接");

  // #1308：vision 回填放宽到 v2
  const visionDefault = () => ({ id: "v0", name: "图片识别模型", baseUrl: "https://v.test", apiKey: "", model: "m", extra: {} }) as never;
  const v2input = {
    configSchemaVersion: 2,
    presets: [{ id: "p1", name: "g", channels: { llm: [{ id: "l1", name: "t", baseUrl: "https://a", apiKey: "k", model: "m", extra: {} }], vision: [], image: [], tts: [] }, active: { llm: "l1", vision: "", image: "", tts: "" } }],
    activePresetId: "p1",
  };
  const v2 = migrateConfigFile(v2input, makeIds(), visionDefault);
  assert(v2.config.presets[0].channels.vision.length === 1, "v2 应回填 vision");
  assert(v2.warnings.length > 0, "回填应有警告");

  // #1308：重复 outputDir 保留首条并警告
  const dup = migrateConfigFile(
    { configSchemaVersion: 3, presets: [], activePresetId: "", projects: [{ id: "a", name: "A", outputDir: "D:/x", novelFileName: "", novelTitle: "", updatedAt: "" }, { id: "b", name: "B", outputDir: "D:/x", novelFileName: "", novelTitle: "", updatedAt: "" }], voiceProfiles: [] },
    makeIds(),
    visionDefault,
  );
  assert(dup.config.projects.length === 1 && dup.config.projects[0].name === "A", "重复目录保留首条");
  assert(dup.warnings.some((w) => w.includes("D:/x")), "重复目录应警告");

  // #1308：坏音色条只丢坏条、好条保留
  const vp = migrateConfigFile(
    {
      configSchemaVersion: 3, presets: [], activePresetId: "", projects: [],
      voiceProfiles: [
        { id: "g1", name: "好", ttsConfigId: "t1", voiceId: "v1" },
        { id: "", name: "", ttsConfigId: "", voiceId: "" },
      ],
    },
    makeIds(),
    visionDefault,
  );
  assert(vp.config.voiceProfiles.length === 1 && vp.config.voiceProfiles[0].id === "g1", "坏条只丢坏条");
  assert(vp.warnings.length > 0, "坏条应警告");

  // #1308：重复 id 改名 + 密钥跟随（store 回退）
  const dupIdInput = {
    configSchemaVersion: 3,
    presets: [{
      id: "p1", name: "g",
      channels: {
        llm: [
          { id: "dup", name: "a", baseUrl: "https://a", apiKey: "", model: "m", extra: {} },
          { id: "dup", name: "b", baseUrl: "https://b", apiKey: "", model: "m2", extra: {} },
        ],
        vision: [], image: [], tts: [],
      },
      active: { llm: "dup", vision: "", image: "", tts: "" },
    }],
    activePresetId: "p1",
  };
  const dupId = migrateConfigFile(dupIdInput, makeIds(), visionDefault);
  assert(dupId.renames.length === 1, "重复 id 应改名");
  assert(dupId.config.presets[0].channels.llm[0].id !== dupId.config.presets[0].channels.llm[1].id, "改名后 id 应不同");
  const loaded = await loadConfigFile(JSON.stringify(dupIdInput), {
    createId: makeIds(),
    createVisionDefault: visionDefault,
    writeConfig: async () => undefined,
    readSecrets: async () => ({ dup: "SECRET-OLD" }),
    writeSecrets: async () => undefined,
  });
  const ids = loaded.config.presets[0].channels.llm.map((c) => c.apiKey);
  assert(ids.includes("SECRET-OLD"), "新 id 应从旧 id 跟随密钥");

  // #1308：未知 baseUrl/model 不置空（原样保留）
  const keep = migrateConfigFile(
    {
      configSchemaVersion: 3, presets: [{
        id: "p1", name: "g",
        channels: { llm: [{ id: "l1", name: "t", baseUrl: "https://custom.example/xyz", apiKey: "", model: "my-model-123", extra: {} }], vision: [{ id: "v1", name: "v", baseUrl: "https://v", apiKey: "", model: "m", extra: {} }], image: [], tts: [] },
        active: { llm: "l1", vision: "v1", image: "", tts: "" },
      }], activePresetId: "p1",
    },
    makeIds(),
    visionDefault,
  );
  assert(keep.config.presets[0].channels.llm[0].baseUrl === "https://custom.example/xyz", "未知 baseUrl 应保留");
  assert(keep.config.presets[0].channels.llm[0].model === "my-model-123", "未知 model 应保留");

  // #1320：空语言保持空语义，导出界面语言独立
  assert(coerceTranslationLanguage("") === "", "空翻译目标保持空");
  assert(coerceTranslationLanguage("zh_CN") === "zh_CN", "非空原样");
  assert(coerceTranslationLanguage(undefined) === "", "非字符串回空");
  assert(normalizeExportUiLanguage("") === "zh_CN", "界面语言空回退 zh_CN");
  assert(normalizeExportUiLanguage("en") === "en", "界面语言合法保留");
  assert(normalizeExportUiLanguage("ko") === "ko", "ko 是合法游戏界面语言（WebgalLanguage），应保留");
  assert(resolveTranslationLanguageUpdate("", "zh_CN", false) === "", "未触碰不覆盖空语言");
  assert(resolveTranslationLanguageUpdate("", "", true) === "", "触碰写空仍保持空（不翻译）");
  assert(resolveTranslationLanguageUpdate("", "en", true) === "en", "触碰写非空生效");

  // #1333：签名纳入 Key 内容（K→K 也能感知），不明文存 Key
  const s1 = modelFetchSignature({ id: "c1", baseUrl: "https://a", apiKey: "wrong-key", extra: {} });
  const s2 = modelFetchSignature({ id: "c1", baseUrl: "https://a", apiKey: "right-key", extra: {} });
  const s3 = modelFetchSignature({ id: "c1", baseUrl: "https://a", apiKey: "right-key", extra: {} });
  assert(s1 !== s2, "改 Key（K→K）签名必须变化");
  assert(s2 === s3, "同 Key 签名稳定");
  assert(!s2.includes("right-key"), "签名不得含明文 Key");
  assert(shouldRefetchModels(s1, s2) === true && shouldRefetchModels(s2, s2) === false, "签名变化才重拉");
  assert(hashKeyFragment("abc") === hashKeyFragment("abc") && hashKeyFragment("abc") !== hashKeyFragment("abd"), "哈希稳定且区分");

  // #1333：失败保留旧列表，仅 endpoint 变化才可清空
  assert(JSON.stringify(mergeDiscoveredModels([{ id: "m1" }], undefined)) === JSON.stringify([{ id: "m1" }]), "失败保留旧列表");
  assert(JSON.stringify(mergeDiscoveredModels([{ id: "m1" }], undefined, { baseUrlChanged: true, clearOnEndpointChange: true })) === "[]", "endpoint 变化才可清空");
  assert(JSON.stringify(applyDiscoveredModelsSuccess([{ id: "m1" }], [{ id: "m2" }])) === JSON.stringify([{ id: "m2" }]), "成功整体替换");
  assert(JSON.stringify(applyDiscoveredModelsFailure([{ id: "m1" }])) === JSON.stringify([{ id: "m1" }]), "失败保留");
  assert(isModelEndpointChanged({ baseUrl: "https://a", pathPrefix: "" }, { baseUrl: "https://b", pathPrefix: "" }) === true, "baseUrl 变化");
  assert(isModelEndpointChanged({ baseUrl: "https://a", pathPrefix: "v1" }, { baseUrl: "https://a", pathPrefix: "v1" }) === false, "相同不判变化");

  // #1315：角色名单一口径 + 分章键命名空间
  assert(resolveCharDisplayName([{ id: "h", name: "主角" }], "h") === "主角", "命中返回名");
  assert(resolveCharDisplayName([], "x") === "x", "未命中回退 id");
  assert(isSplitConfirmKeyForDir("novelforge:splitConfirmed:D:/a", "D:/a") === true, "同目录键匹配");
  assert(isSplitConfirmKeyForDir("novelforge:splitConfirmed:D:/b", "D:/a") === false, "异目录键不匹配");

  console.log("=== batch-s ReqFlow 回归（1299/1300/1308/1315/1320/1333）通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
