/**
 * Tauri IPC 契约守卫：JS 侧 invoke 传的参数名，经 camelCase->snake_case 转换后，
 * 必须正好覆盖 Rust 命令签名里的全部参数（app/tauri/state 由 Tauri 注入，不算）。
 *
 * 为什么值得守：Tauri v2 只在**运行时**按名字取参，参数名写错不会编译失败、
 * cargo test 也跑不到，只会等到用户点到那个功能才报 missing argument。
 *
 * 注：上一次尝试用正则抽参数时踩过坑——捕获的键名后面少了闭合的 }，
 * 导致所有 "{ path }" 形式的调用抽成空集，凭空报出 29 条不一致。这里用带回看的写法。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Tauri 自身注入的参数，JS 不用传 */
const INJECTED = new Set(["app", "tauri", "state"]);
const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const rd = (p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");

/** Rust 侧：#[tauri::command] 的命令名 -> snake_case 参数集 */
function rustCommands(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of ["commands.rs", "models.rs"]) {
    const src = rd(["src-tauri", "src", f]);
    const re = /#\[tauri::command\][\s\S]{0,400}?pub (?:async )?fn ([a-z0-9_]+)\s*\(([\s\S]{0,400}?)\)\s*->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const args = (m[2].match(/([a-z_][a-z0-9_]*)\s*:/g) || [])
        .map((x) => x.replace(/\s*:$/, ""))
      out.set(m[1], new Set(args.filter((a) => !INJECTED.has(a))));
    }
  }
  return out;
}

/** JS 侧：命令名 -> 该命令所有调用点传过的 key 并集（已转 snake_case） */
function jsInvocations(): Map<string, Set<string>> {
  const src = rd(["src", "utils", "tauri.ts"]);
  const out = new Map<string, Set<string>>();
  const re = /invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"\s*,\s*\{([\s\S]{0,500}?)\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cmd = m[1];
    if (!out.has(cmd)) out.set(cmd, new Set<string>());
    // 关键：把闭合的 } 补回去，否则 "{ path }" 的 path 后面没有可匹配的结尾字符
    const inner = m[2] + "}";
    const keys = inner.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*[,:}]/g);
    for (const k of keys) out.get(cmd)!.add(snake(k[1]));
  }
  return out;
}

function main(): void {
  const rust = rustCommands();
  const js = jsInvocations();
  assert(rust.size >= 30, "Rust 命令数异常偏少：" + rust.size);
  assert(js.size >= 20, "JS 调用点数异常偏少：" + js.size);

  const problems: string[] = [];
  for (const [cmd, keys] of js) {
    const want = rust.get(cmd);
    if (!want) { problems.push(cmd + "：Rust 侧没有这个命令（悬空调用）"); continue; }
    const missing = [...want].filter((a) => !keys.has(a));
    if (missing.length) {
      problems.push(cmd + "：未传 " + missing.join(",") + "（Rust 要 " + [...want].join(",") + "）");
    }
  }
  assert(problems.length === 0, problems.join(
    "；"
  ) + "（#1549）");


  // ---- 事件方向：Rust emit 的每个事件都必须有 JS listen 接住 ----
  // 与 invoke 同理：事件名写错只在运行时表现为「界面永远不刷新」，不报错也不编译失败。
  // 只认 Tauri 的 listen("x")；组件里的 emit("x") 是 Vue 自定义事件，不属于这里。
  const listened = new Set<string>();
  {
    const src = rd(["src", "utils", "tauri.ts"]);
    for (const m of src.matchAll(/listen(?:<[^>]*>)?\(\s*"([A-Za-z0-9_:.-]+)"/g)) listened.add(m[1]);
  }
  const emitted = new Set<string>();
  for (const f of ["commands.rs", "models.rs", "server.rs", "lib.rs"]) {
    const src = rd(["src-tauri", "src", f]);
    for (const m of src.matchAll(/\.emit(?:_all|_to)?\s*\(\s*"([A-Za-z0-9_:.-]+)"/g)) emitted.add(m[1]);
  }
  assert(emitted.size > 0, "Rust 侧没抽到任何 emit 事件，抽取器失效了（#1549）");
  const orphan = [...emitted].filter((e) => !listened.has(e));
  assert(orphan.length === 0,
    "Rust emit 但没有任何 JS listen 的事件：" + orphan.join(",") + "（#1549）");

  console.log(
    "=== Tauri IPC 契约一致（已核 " + js.size + " 个命令 / Rust " + rust.size + " 个，" +
      "事件 " + emitted.size + " 个，参数名与事件名均无缺漏）==="
  );
}

main();