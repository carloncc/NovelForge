/**
 * #1296 Web 端密钥存储：默认内存、opt-in 加密 sessionStorage、旧明文迁移+警告。
 * 注入 KeyStorageLike fake，不碰真实浏览器存储；不要求 ConfigPage（另一路）。
 */
import {
  CIPHER_KEY,
  LEGACY_PLAINTEXT_KEY,
  OPTIN_KEY,
  applySecretPatch,
  dropMemoryForTests,
  initWebSecrets,
  isPersistOptIn,
  mergeSecretMaps,
  migrateLegacyPlaintext,
  parseLegacyPlaintext,
  pickSecrets,
  readWebSecrets,
  resetWebKeysForTests,
  restoreEncrypted,
  setPersistOptIn,
  subtleAvailable,
  writeWebSecretsAsync,
  type KeyStorageLike,
} from "../src/utils/webKeys";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function fakeStorage(seed: Record<string, string> = {}): KeyStorageLike & { writes: string[]; data: Record<string, string> } {
  const data = { ...seed };
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => {
      writes.push(k);
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const SECRET_A = "sk-live-aaa111bbb222ccc333";
const SECRET_B = "sk-live-ddd444eee555fff666";

/* ---------- 1) 纯函数：解析/合并/挑选 ---------- */
{
  const good = parseLegacyPlaintext(JSON.stringify({ a: SECRET_A, empty: "", n: 1 }));
  assert(good.secrets.a === SECRET_A && !("empty" in good.secrets) && !good.corrupt, "明文解析应只收非空字符串");
  assert(parseLegacyPlaintext(null).corrupt === false, "空槽位不算损坏");
  assert(parseLegacyPlaintext("{bad").corrupt === true, "坏 JSON 判 corrupt");
  assert(parseLegacyPlaintext("[1,2]").corrupt === true, "非对象判 corrupt");

  const merged = mergeSecretMaps({ a: "1", b: "2" }, { b: "", c: "3" });
  assert(merged.a === "1" && !("b" in merged) && merged.c === "3", "合并：空串删键、非空写入");

  const picked = pickSecrets(new Map([["a", "1"], ["b", "2"]]), ["b", "missing"]);
  assert(picked.b === "2" && !("a" in picked) && !("missing" in picked), "挑选应只返回请求的已存键");
}

/* ---------- 2) 默认内存优先：不写任何 storage ---------- */
{
  resetWebKeysForTests();
  const ss = fakeStorage();
  const ls = fakeStorage();
  assert(!isPersistOptIn(ls), "默认未 opt-in");
  await writeWebSecretsAsync({ cfg1: SECRET_A }, ss, ls);
  assert(ss.writes.length === 0, "默认行为不得写 sessionStorage（内存优先）");
  assert(ls.writes.length === 0, "默认行为不得写 localStorage");
  assert(readWebSecrets(["cfg1"]).cfg1 === SECRET_A, "内存读写应命中");
  assert(Object.keys(readWebSecrets(["nope"])).length === 0, "缺键返回空对象");
}

/* ---------- 3) 旧明文迁移：迁入内存 + 清槽 + 警告 ---------- */
{
  resetWebKeysForTests();
  const ss = fakeStorage({ [LEGACY_PLAINTEXT_KEY]: JSON.stringify({ cfg1: SECRET_A, cfg2: SECRET_B }) });
  const m = migrateLegacyPlaintext(ss);
  assert(m.migrated === 2 && m.cleared && !m.corrupt, "应迁 2 个并清槽");
  assert(m.warnings.length > 0, "迁移必须给出警告文案");
  assert(!(LEGACY_PLAINTEXT_KEY in ss.data), "旧明文键必须清除");
  assert(readWebSecrets(["cfg1", "cfg2"]).cfg1 === SECRET_A, "迁入值应在内存可读");

  // 幂等：无旧键时零操作零警告
  const m2 = migrateLegacyPlaintext(ss);
  assert(m2.migrated === 0 && m2.warnings.length === 0, "无旧键应静默");

  // 坏数据：清除 + corrupt 警告
  const bad = fakeStorage({ [LEGACY_PLAINTEXT_KEY]: "{corrupt" });
  const m3 = migrateLegacyPlaintext(bad);
  assert(m3.corrupt && !(LEGACY_PLAINTEXT_KEY in bad.data) && m3.warnings.length > 0, "坏数据应清除并警告");
}

/* ---------- 4) opt-in 加密落盘：密文无明文 + 同会话可恢复 ---------- */
{
  resetWebKeysForTests();
  const ss = fakeStorage();
  const ls = fakeStorage();
  setPersistOptIn(true, ls, ss);
  assert(isPersistOptIn(ls), "opt-in 开关应落 localStorage");
  assert(ls.data[OPTIN_KEY] === "1" && !(CIPHER_KEY in ls.data), "localStorage 只存开关，不存密钥");
  await writeWebSecretsAsync({ cfg1: SECRET_A }, ss, ls);

  if (subtleAvailable()) {
    const cipher = ss.data[CIPHER_KEY];
    assert(typeof cipher === "string" && cipher.length > 0, "opt-in 后应写加密槽位");
    assert(!cipher.includes(SECRET_A), "密文不得包含明文密钥");
    const env = JSON.parse(cipher) as { alg?: string };
    assert(env.alg === "AES-GCM-256", "应为 AES-GCM-256 信封");

    // 同会话恢复：只丢内存、保留密钥句柄
    dropMemoryForTests();
    assert(Object.keys(readWebSecrets(["cfg1"])).length === 0, "丢内存后应读不到");
    const r = await restoreEncrypted(ss, ls);
    assert(r.restored === 1 && !r.undecryptable, "同会话应解密恢复");
    assert(readWebSecrets(["cfg1"]).cfg1 === SECRET_A, "恢复值应一致");

    // 会话更换（密钥句柄丢失）：判 undecryptable 并清槽
    resetWebKeysForTests();
    const r2 = await restoreEncrypted(ss, ls);
    assert(r2.undecryptable && !(CIPHER_KEY in ss.data), "换会话应判不可解密并清槽");

    // 关闭 opt-in：清密文，内存保留到页面关闭
    await writeWebSecretsAsync({ cfg1: SECRET_A }, ss, ls);
    setPersistOptIn(false, ls, ss);
    assert(!isPersistOptIn(ls) && !(CIPHER_KEY in ss.data), "关闭 opt-in 应清密文与开关");
    assert(readWebSecrets(["cfg1"]).cfg1 === SECRET_A, "内存值在关闭后仍可用到页面关闭");
  } else {
    assert(!(CIPHER_KEY in ss.data), "无 WebCrypto 时不得落盘（纯内存）");
  }
}

/* ---------- 5) initWebSecrets：迁移+恢复一站式，警告汇总 ---------- */
{
  resetWebKeysForTests();
  const ss = fakeStorage({ [LEGACY_PLAINTEXT_KEY]: JSON.stringify({ cfg9: SECRET_B }) });
  const ls = fakeStorage();
  const init = await initWebSecrets(ss, ls);
  assert(init.migrated === 1 && init.warnings.length > 0, "init 应迁移旧值并汇总警告");
  assert(readWebSecrets(["cfg9"]).cfg9 === SECRET_B, "init 后内存可读");

  // applySecretPatch 语义：空串删键
  applySecretPatch({ cfg9: "" });
  assert(Object.keys(readWebSecrets(["cfg9"])).length === 0, "空串补丁应删内存键");
}

console.log("unit-nb-nh-1296: 全部通过 ✅");
