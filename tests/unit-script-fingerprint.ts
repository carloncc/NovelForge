/**
 * 剧本缓存指纹唯一实现（#802/#801）：公式锁定 + 开关隔离 + 旧格式兼容。
 * 7 处调用点（管线/看板/章节灯/核对）必须与这里一致，否则会出现
 * 「看板绿灯但产物是旧的」或「永远重跑」。
 */
import { cardsFingerprint, scriptFingerprint, titleHash } from "../src/core/cache";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// 1) 无文风、不压缩 → 空串（与旧公式完全一致，老项目缓存不失效）
assert(scriptFingerprint({}) === "", "无参数应为空串");
assert(scriptFingerprint({ style: "" }) === "", "空文风应为空串");
assert(scriptFingerprint({ style: "  " }) === "", "纯空白文风应为空串");
assert(scriptFingerprint(undefined) === "", "undefined 应为空串");
assert(scriptFingerprint("") === "", "字符串入参空值应为空串");

// 2) 只有文风时与旧公式一致
const style = "古风典雅";
assert(scriptFingerprint({ style }) === `_st${titleHash(style)}`, "文风指纹应与旧公式一致");
assert(scriptFingerprint(style) === `_st${titleHash(style)}`, "字符串入参应兼容");
assert(scriptFingerprint({ style: `  ${style}  ` }) === `_st${titleHash(style)}`, "文风应去首尾空白");

// 3) 压缩旁白开关改变指纹
const off = scriptFingerprint({ style });
const on = scriptFingerprint({ style, compressNarration: true });
assert(off !== on, "压缩开关必须改变剧本指纹");
assert(on.includes("_cn1"), "压缩开启应带 _cn1 标记");
assert(scriptFingerprint({ compressNarration: true }) === "_cn1", "无文风时压缩标记仍应生效");

// 4) 视觉模式进入指纹（图片小说隔离，见 #808）
assert(scriptFingerprint({ visualMode: "sprite" }) === "", "sprite 为默认模式不产生后缀");
const imageOnly = scriptFingerprint({ visualMode: "imageOnly" });
assert(imageOnly !== "", "imageOnly 必须产生模式后缀");
assert(imageOnly !== scriptFingerprint({ visualMode: "sprite" }), "两套模式指纹必须不同");
assert(
  scriptFingerprint({ style, compressNarration: true, visualMode: "imageOnly" }) !==
    scriptFingerprint({ style, compressNarration: false, visualMode: "sprite" }),
  "组合参数必须整体区分",
);

// 5) 同输入同输出（稳定）
assert(scriptFingerprint({ style, compressNarration: true }) === scriptFingerprint({ style, compressNarration: true }), "同输入必须同输出");

/* ---------- 6) 卡片指纹（重新提取导致 id 变化 → 旧剧本必须失效） ---------- */
const cardsA = {
  characters: [{ id: "xigangjingyinyue", name: "西园寺樱月" }, { id: "zuoyeyoudou", name: "佐野优斗" }],
  items: [{ id: "diary", name: "日记本" }],
  scenes: [{ id: "s1", location: "街道十字路口" }],
};
const cardsB = {
  characters: [{ id: "sakuragitsuki", name: "西园寺樱月" }, { id: "yuto", name: "佐野优斗" }],
  items: [{ id: "diary", name: "日记本" }],
  scenes: [{ id: "s1", location: "街道十字路口" }],
};
const fpA = cardsFingerprint(cardsA);
assert(cardsFingerprint(cardsA) === fpA, "同一卡片集指纹必须稳定");
assert(cardsFingerprint(cardsB) !== fpA, "角色 id 变化必须改变卡片指纹");
assert(cardsFingerprint({ ...cardsA, items: [{ id: "diary", name: "笔记本" }] }) !== fpA, "物品名称变化应改变指纹");
assert(cardsFingerprint({ characters: [] }) !== fpA, "空卡片与有卡片必须不同");

const withCards = scriptFingerprint({ style, cardsFp: fpA });
assert(withCards !== scriptFingerprint({ style }), "带卡片指纹的剧本键必须不同");
assert(withCards.includes(`_cd${fpA}`), "卡片指纹应以 _cd 后缀进入键");
assert(scriptFingerprint({ style, cardsFp: fpA }) === withCards, "同卡片同输入必须同键");

console.log("=== script fingerprint tests passed ===");
