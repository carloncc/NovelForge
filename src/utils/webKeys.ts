/**
 * Web 端 API Key 存储（#1296，最小可用闭环）：
 * - 默认纯内存 Map：关闭页面/刷新即失效，同源脚本扫 storage 也拿不到明文；
 * - opt-in 才进 sessionStorage，且必须经 WebCrypto AES-GCM 非导出密钥加密后才落盘；
 *   密钥句柄存 IndexedDB（结构化克隆可恢复句柄、导不出料），密文与句柄分开存放；
 * - localStorage 只存 opt-in 开关（"1"），永不存密钥明文/密文；
 * - 首次初始化把旧明文键 novelforge:api-secrets 迁入内存并清除（迁移+警告）。
 *
 * 说明：ConfigPage.vue 的 opt-in 复选框由另一路负责；本文件只做存储核心+迁移。
 * Node 单测通过注入 KeyStorageLike fake 覆盖纯逻辑；加密往返需 crypto.subtle（缺失时仅内存，不落盘）。
 */
import { t } from "../i18n";

export interface KeyStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 旧明文槽位（只读迁移用；迁移后清除，不再写入） */
export const LEGACY_PLAINTEXT_KEY = "novelforge:api-secrets";
/** 新加密槽位（sessionStorage，opt-in 才写） */
export const CIPHER_KEY = "novelforge:api-secrets.enc.v1";
/** opt-in 开关槽位（localStorage，值为 "1" 表示用户明确同意会话级持久化） */
export const OPTIN_KEY = "novelforge:api-secrets.persist";

/* ==================== 默认存储（缺失时返回 undefined，调用方降级为纯内存） ==================== */

export function defaultSessionStorage(): KeyStorageLike | undefined {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

export function defaultLocalStorage(): KeyStorageLike | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/* ==================== 内存态（默认行为：只在这里） ==================== */

const mem = new Map<string, string>();

/** 单测隔离：清空内存态与密钥句柄 */
export function resetWebKeysForTests(): void {
  mem.clear();
  encKeyPromise = null;
  persistError = "";
}

/** 单测：只丢内存（保留密钥句柄），模拟同会话恢复 */
export function dropMemoryForTests(): void {
  mem.clear();
}

/* ==================== 纯函数（单测入口） ==================== */

/** 按 id 挑密钥（只返回存在的键；与旧 webReadApiSecrets 的 hasOwnProperty 口径一致） */
export function pickSecrets(source: Record<string, string> | Map<string, string>, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const v = source instanceof Map ? source.get(id) : Object.prototype.hasOwnProperty.call(source, id) ? source[id] : undefined;
    if (typeof v === "string") out[id] = v;
  }
  return out;
}

/** 合并补丁：非空写入，空串删除（与旧 webWriteApiSecrets 口径一致） */
export function mergeSecretMaps(base: Record<string, string>, patch: Record<string, string>): Record<string, string> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v) out[k] = v;
    else delete out[k];
  }
  return out;
}

/** 解析旧明文槽位内容（坏 JSON/非对象判 corrupt，不抛错） */
export function parseLegacyPlaintext(raw: string | null): { secrets: Record<string, string>; corrupt: boolean } {
  if (raw == null) return { secrets: {}, corrupt: false };
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { secrets: {}, corrupt: true };
    const out: Record<string, string> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      if (typeof vv === "string" && vv) out[k] = vv;
    }
    return { secrets: out, corrupt: false };
  } catch {
    return { secrets: {}, corrupt: true };
  }
}

/* ==================== opt-in 开关 ==================== */

export function isPersistOptIn(ls: KeyStorageLike | undefined = defaultLocalStorage()): boolean {
  try {
    return ls?.getItem(OPTIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPersistOptIn(on: boolean, ls: KeyStorageLike | undefined = defaultLocalStorage(), ss: KeyStorageLike | undefined = defaultSessionStorage()): void {
  try {
    if (on) ls?.setItem(OPTIN_KEY, "1");
    else {
      ls?.removeItem(OPTIN_KEY);
      // 关闭即失效：连会话级密文也一起丢，内存态保留到页面关闭
      ss?.removeItem(CIPHER_KEY);
    }
  } catch {
    /* 存储不可用时保持纯内存，不抛错 */
  }
}

/* ==================== 内存读写（Web 运行时唯一默认路径） ==================== */

export function readWebSecrets(ids: string[]): Record<string, string> {
  return pickSecrets(mem, ids);
}

/** 内存补丁（同步生效；持久化由调用方按需 flush，避免写盘竞态） */
export function applySecretPatch(patch: Record<string, string>): void {
  const merged = mergeSecretMaps(Object.fromEntries(mem), patch);
  mem.clear();
  for (const [k, v] of Object.entries(merged)) mem.set(k, v);
}

export async function writeWebSecretsAsync(
  patch: Record<string, string>,
  ss: KeyStorageLike | undefined = defaultSessionStorage(),
  ls: KeyStorageLike | undefined = defaultLocalStorage(),
): Promise<void> {
  applySecretPatch(patch);
  await flushWebSecrets(ss, ls);
}

/* ==================== WebCrypto 加密持久化（opt-in 才调用） ==================== */

let encKeyPromise: Promise<CryptoKey | null> | null = null;
let persistError = "";

export function webKeysPersistError(): string {
  return persistError;
}

function subtleCrypto(): SubtleCrypto | null {
  try {
    const g = globalThis as unknown as { crypto?: { subtle?: SubtleCrypto; getRandomValues?: (a: Uint8Array) => void } };
    return g.crypto?.subtle ?? null;
  } catch {
    return null;
  }
}

export function subtleAvailable(): boolean {
  return subtleCrypto() !== null;
}

function getOrCreateKey(): Promise<CryptoKey | null> {
  if (!encKeyPromise) {
    encKeyPromise = (async () => {
      const s = subtleCrypto();
      if (!s) return null;
      // 先从 IndexedDB 取（非导出密钥支持结构化克隆进 IDB：句柄可恢复、料不可导）；
      // 取不到则生成并尽力存 IDB（失败也不挡本次会话使用）。
      const kept = await idbLoadKey();
      if (kept) return kept;
      // 非导出密钥：extractable=false，内存持有，料永不出内存
      const fresh = await s.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      void idbSaveKey(fresh);
      return fresh;
    })();
  }
  return encKeyPromise;
}

function isCryptoKeyLike(v: unknown): v is CryptoKey {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "secret";
}

function openKeyDb(): Promise<IDBDatabase | null> {
  try {
    const idb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = idb.open("novelforge-webkeys", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("store")) req.result.createObjectStore("store");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return Promise.resolve(null);
  }
}

async function idbLoadKey(): Promise<CryptoKey | null> {
  const db = await openKeyDb();
  if (!db) return null;
  try {
    const value = await new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction("store", "readonly");
        const rq = tx.objectStore("store").get("aes-key");
        rq.onsuccess = () => resolve(rq.result ?? null);
        rq.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return isCryptoKeyLike(value) ? value : null;
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function idbSaveKey(key: CryptoKey): Promise<void> {
  const db = await openKeyDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction("store", "readwrite");
        const rq = tx.objectStore("store").put(key, "aes-key");
        rq.onsuccess = () => resolve();
        rq.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

function bytesToB64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return (globalThis as unknown as { btoa(s: string): string }).btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const g = globalThis as unknown as { Buffer?: { from(s: string, e: string): Uint8Array } };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, "base64"));
  const s = (globalThis as unknown as { atob(s: string): string }).atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomIv(): Uint8Array {
  const iv = new Uint8Array(12);
  try {
    const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => void } };
    if (g.crypto?.getRandomValues) {
      g.crypto.getRandomValues(iv);
      return iv;
    }
  } catch {
    /* 回退弱随机（仅 IV，密钥仍为密码学随机） */
  }
  for (let i = 0; i < iv.length; i++) iv[i] = Math.floor(Math.random() * 256);
  return iv;
}

/** 把内存态加密落盘（opt-in 且 subtle 可用才真写；否则返回 false 并记错） */
export async function flushWebSecrets(
  ss: KeyStorageLike | undefined = defaultSessionStorage(),
  ls: KeyStorageLike | undefined = defaultLocalStorage(),
): Promise<boolean> {
  if (!ss || !isPersistOptIn(ls)) return false;
  const s = subtleCrypto();
  if (!s) {
    persistError = t("Web 密钥存储：当前环境不支持 WebCrypto，已回退为仅内存存储（关闭页面后失效）。");
    return false;
  }
  try {
    const key = await getOrCreateKey();
    if (!key) throw new Error("no key");
    const iv = randomIv();
    const ct = await s.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(Object.fromEntries(mem))));
    ss.setItem(CIPHER_KEY, JSON.stringify({ v: 1, alg: "AES-GCM-256", iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) }));
    persistError = "";
    return true;
  } catch {
    persistError = t("Web 密钥存储：加密持久化失败，已回退为仅内存存储（关闭页面后失效）。");
    return false;
  }
}

/** 从加密槽位恢复到内存（只填空位，不覆盖已有内存值；信封非法/解密失败则清槽并报 undecryptable） */
export async function restoreEncrypted(
  ss: KeyStorageLike | undefined = defaultSessionStorage(),
  ls: KeyStorageLike | undefined = defaultLocalStorage(),
): Promise<{ restored: number; undecryptable: boolean }> {
  const none = { restored: 0, undecryptable: false };
  if (!ss || !isPersistOptIn(ls)) return none;
  let raw: string | null = null;
  try {
    raw = ss.getItem(CIPHER_KEY);
  } catch {
    return none;
  }
  if (!raw) return none;
  try {
    const env = JSON.parse(raw) as { v?: unknown; alg?: unknown; iv?: unknown; data?: unknown };
    if (env.v !== 1 || env.alg !== "AES-GCM-256" || typeof env.iv !== "string" || typeof env.data !== "string") {
      throw new Error("bad envelope");
    }
    const s = subtleCrypto();
    const key = await getOrCreateKey();
    if (!s || !key) throw new Error("no crypto");
    const pt = await s.decrypt({ name: "AES-GCM", iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data));
    const obj = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v && !mem.has(k)) {
        mem.set(k, v);
        n++;
      }
    }
    return { restored: n, undecryptable: false };
  } catch {
    try {
      ss.removeItem(CIPHER_KEY);
    } catch {
      /* 忽略 */
    }
    return { restored: 0, undecryptable: true };
  }
}

/* ==================== 旧明文迁移 + 启动初始化 ==================== */

/** 旧明文迁入内存并清槽（幂等：无旧键直接返回；只填内存空位） */
export function migrateLegacyPlaintext(
  ss: KeyStorageLike | undefined = defaultSessionStorage(),
): { migrated: number; cleared: boolean; corrupt: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const idle = { migrated: 0, cleared: false, corrupt: false, warnings };
  if (!ss) return idle;
  let raw: string | null;
  try {
    raw = ss.getItem(LEGACY_PLAINTEXT_KEY);
  } catch {
    return idle;
  }
  if (raw == null) return idle;
  const { secrets, corrupt } = parseLegacyPlaintext(raw);
  const found = Object.keys(secrets).length;
  for (const [k, v] of Object.entries(secrets)) {
    if (!mem.has(k)) mem.set(k, v);
  }
  let cleared = false;
  try {
    ss.removeItem(LEGACY_PLAINTEXT_KEY);
    cleared = true;
  } catch {
    cleared = false;
  }
  if (found > 0) {
    warnings.push(t("Web 密钥存储：已将 {n} 个密钥从明文存储迁移到内存并清除明文，关闭页面后失效。", { n: found }));
  }
  if (corrupt) {
    warnings.push(t("Web 密钥存储：发现损坏的旧密钥数据，已清除。"));
  }
  return { migrated: found, cleared, corrupt, warnings };
}

/** 启动初始化：先迁旧明文，再按 opt-in 恢复加密槽位；返回警告供 UI/日志透出 */
export async function initWebSecrets(
  ss: KeyStorageLike | undefined = defaultSessionStorage(),
  ls: KeyStorageLike | undefined = defaultLocalStorage(),
): Promise<{ migrated: number; restored: number; warnings: string[] }> {
  const warnings: string[] = [];
  const m = migrateLegacyPlaintext(ss);
  warnings.push(...m.warnings);
  let restored = 0;
  if (isPersistOptIn(ls)) {
    const r = await restoreEncrypted(ss, ls);
    restored = r.restored;
    if (r.undecryptable) {
      warnings.push(t("Web 密钥存储：加密数据无法解密（会话已更换），已清除，需重新输入密钥。"));
    }
  }
  return { migrated: m.migrated, restored, warnings };
}
