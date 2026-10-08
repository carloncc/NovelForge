/**
 * #1546：把 dedupeSceneIdsAcrossChapters 注释里写死的承诺逐条钉住。
 *
 * 注释原文：「幂等：首次出现的 id（含已带 _数字 后缀）原样保留；冲突时剥掉旧数字后缀后递增，
 * 保证 s1_2 冲突得 s1_3 而非 s1_2_2」。
 *
 * 「保证」是最强的措辞，但它当时只是一句注释、没有任何测试兜着——一旦有人把
 * stem 的推导改成 slice 或去掉 while 里的跳过检查，s1_2 就会退化成 s1_2_2，
 * 而画面上只表现为多一个背景文件，很难被察觉。
 */
import { dedupeSceneIdsAcrossChapters } from "../src/core/pipeline";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Scene = { id: string };

function apply(ids: string[]): string[] {
  const chapters = [{ scenes: ids.map((id) => ({ id })) }] as unknown as Parameters<typeof dedupeSceneIdsAcrossChapters>[0];
  dedupeSceneIdsAcrossChapters(chapters);
  return (chapters[0] as unknown as { scenes: Scene[] }).scenes.map((s) => s.id);
}

function main(): void {
  // ① 注释点名的那个例子：必须得 s1_3，绝不能是 s1_2_2
  assert(
    JSON.stringify(apply(["s1_2", "s1_2"])) === JSON.stringify(["s1_2", "s1_3"]),
    "注释点名的 s1_2 冲突必须得 s1_3，实际 " + JSON.stringify(apply(["s1_2", "s1_2"])) + "（#1546）",
  );

  // ② 首次出现的 id（含已带 _数字 后缀）必须原样保留
  for (const ids of [["s1_2"], ["s1_7"], ["a_b"], ["s1", "s1_2"], [".replace"], ["1_a"]]) {
    assert(
      JSON.stringify(apply(ids)) === JSON.stringify(ids),
      "无冲突时必须原样保留：" + JSON.stringify(ids) + " -> " + JSON.stringify(apply(ids)) + "（#1546）",
    );
  }

  // ③ 幂等：跑第二遍不得改变任何 id（注释里的「幂等」二字）
  for (const ids of [["s1", "s1", "s1_2"], ["a_b", "a", "a_b"], ["x", "x", "x", "x"]]) {
    const once = apply(ids);
    const twice = apply(once);
    assert(
      JSON.stringify(once) === JSON.stringify(twice),
      "第二遍不得改动：" + JSON.stringify(once) + " -> " + JSON.stringify(twice) + "（#1546）",
    );
  }

  // ④ 全局唯一：这正是这个函数存在的理由（注释：92 个背景任务挤进 6 个文件）
  for (const ids of [
    ["s1", "s1", "s1_2", "s1_2", "s1_3"],
    ["x", "x", "x", "x", "x"],
    ["a", "a_b", "a_b", "a_b"],
    ["", "", "x"],
  ]) {
    const out = apply(ids);
    assert(
      new Set(out).size === out.length,
      "结果必须全局唯一：" + JSON.stringify(ids) + " -> " + JSON.stringify(out) + "（#1546）",
    );
  }

  // ⑤ 冲突递增不得撞上任何已被占用的名字（含非本轮产生的占用）
  const out = apply(["s1", "s1", "s1_2", "s1", "s1_2", "s1_3", "s1"]);
  assert(new Set(out).size === out.length, "多轮冲突仍须唯一：" + JSON.stringify(out) + "（#1546）");
  assert(
    JSON.stringify(out) === JSON.stringify(["s1", "s1_2", "s1_3", "s1_4", "s1_5", "s1_6", "s1_7"]),
    "递增序列应连续无洞，实际 " + JSON.stringify(out) + "（#1546）",
  );

  // ⑥ 空 id 归一为 s（不得产出空串键）
  const e = apply(["", ""]);
  assert(e[0] === "s" && e[1] !== "", "空 id 必须归一为非空键，实际 " + JSON.stringify(e) + "（#1546）");

  console.log("=== 场景 id 去重承诺测试通过（#1546：s1_2 冲突得 s1_3、幂等、全局唯一）===");
}

main();
