/**
 * #1530：loadConfigFile 何时回写密钥——把「含明文 key」这个判据钉住。
 *
 * `loadConfigFile` 只在 `migration.migrated || containsInlineApiKey(parsed)` 时才
 * `writeSecrets` + `writeConfig`。若把 containsInlineApiKey 改成「只要没有 presets 就算有明文 key」，
 * 任何**不含 presets 的当前版本配置**都会被无谓地重写一遍配置文件——整套测试原本全绿（变异测试发现）。
 */
import { loadConfigFile, CONFIG_SCHEMA_VERSION } from "../src/stores/configMigration";
import type { ConfigFile } from "../src/stores/configMigration";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Counters {
  writeSecrets: number;
  writeConfig: number;
}

async function load(raw: unknown): Promise<{ counters: Counters; result: Awaited<ReturnType<typeof loadConfigFile>> }> {
  const counters: Counters = { writeSecrets: 0, writeConfig: 0 };
  const result = await loadConfigFile(JSON.stringify(raw), {
    createId: (() => { let n = 0; return () => `id${++n}`; })(),
    createVisionDefault: () => { throw new Error("测试里不应创建 vision 默认配置"); },
    writeConfig: async () => { counters.writeConfig++; },
    readSecrets: async () => ({}),
    writeSecrets: async () => { counters.writeSecrets++; },
  });
  return { counters, result };
}

async function main(): Promise<void> {
  // ① 当前版本、无 presets → 不得触发任何回写（变异点：无 presets 也当成含明文 key）
  const empty: Partial<ConfigFile> = { configSchemaVersion: CONFIG_SCHEMA_VERSION, presets: [] };
  const a = await load(empty);
  assert(a.counters.writeSecrets === 0, `无 presets 的当前版本配置不应回写密钥，实际写了 ${a.counters.writeSecrets} 次（#1530）`);
  assert(a.counters.writeConfig === 0, `无 presets 的当前版本配置不应回写配置文件，实际写了 ${a.counters.writeConfig} 次（#1530）`);

  // ② presets 字段整个缺失（非数组）→ 同样不得回写
  const b = await load({ configSchemaVersion: CONFIG_SCHEMA_VERSION });
  assert(b.counters.writeSecrets === 0, `presets 字段缺失时不应回写密钥，实际 ${b.counters.writeSecrets} 次（#1530）`);

  // ③ 确有内联 apiKey → 必须回写（这是 #1504/#1308 依赖的正向路径，不能被误伤）
  const inline = await load({
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    presets: [{ id: "p1", name: "P1", channels: { text: [{ id: "c1", name: "C1", adapter: "openai", baseUrl: "https://api.x.com", model: "m", apiKey: "sk-inline" }] } }],
  });
  assert(inline.counters.writeSecrets === 1, `含内联 apiKey 的配置应回写密钥一次，实际 ${inline.counters.writeSecrets} 次（#1530）`);
  assert(inline.counters.writeConfig === 1, `含内联 apiKey 的配置应回写配置文件一次，实际 ${inline.counters.writeConfig} 次（#1530）`);

  // ④ 老版本（需要迁移）→ 必须回写（migrated 分支，不能被误伤）
  const old = await load({ configSchemaVersion: 1, presets: [] });
  assert(old.counters.writeConfig === 1, `需迁移的旧配置应回写配置文件一次，实际 ${old.counters.writeConfig} 次（#1530）`);

  console.log("=== 密钥回写判据测试通过（#1530：无明文 key 且无需迁移时不得回写；有则必须回写）===");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
