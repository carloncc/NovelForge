/**
 * AI 音色分配校验（纯函数）：越界音色回退、性别纠正、未知角色丢弃、非 NPC 不撞色。
 */
import { applyVoiceAssignments } from "../src/core/voiceCast";
import type { CharacterCard } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const LIB = ["male-qn-qingse", "female-shaonv", "female-yujie", "Chinese (Mandarin)_Gentleman"];

function char(id: string, name: string, gender: "male" | "female", isNpc = false): CharacterCard {
  return { id, name, gender, isNpc, appearance: "", clothing: "", personality: "", voiceDesc: "", imagePrompt: "", color: "" };
}

const characters: CharacterCard[] = [
  char("su", "苏晚晴", "female"),
  char("lin", "林澈", "male"),
  char("liu", "柳儿", "female"),
  char("dian", "店小二", "male", true),
];

// 1) 越界音色（不在库内）→ 按性别回退到库内同性别音色
const r1 = applyVoiceAssignments(characters, [{ characterId: "su", voiceName: "not-in-lib" }], LIB);
assert(r1.length === 1 && LIB.includes(r1[0].voiceName), "越界音色应回退到库内音色");
assert(r1[0].voiceName.startsWith("female"), `female 角色不应拿到男声（实际 ${r1[0].voiceName}）`);

// 2) 性别不符（男声给女角色）→ 纠正为女声
const r2 = applyVoiceAssignments(characters, [{ characterId: "su", voiceName: "Chinese (Mandarin)_Gentleman" }], LIB);
assert(r2[0].voiceName.startsWith("female"), `性别不符应被纠正（实际 ${r2[0].voiceName}）`);

// 3) 未知角色 id → 丢弃
const r3 = applyVoiceAssignments(characters, [{ characterId: "ghost", voiceName: "female-shaonv" }], LIB);
assert(r3.length === 0, "未知角色应被丢弃");

// 4) 非 NPC 撞色 → 第二位改挑未占用的同性别音色；NPC 允许复用
const r4 = applyVoiceAssignments(
  characters,
  [
    { characterId: "su", voiceName: "female-shaonv" },
    { characterId: "liu", voiceName: "female-shaonv" },
    { characterId: "lin", voiceName: "male-qn-qingse" },
    { characterId: "dian", voiceName: "male-qn-qingse" },
  ],
  LIB,
);
const byId = new Map(r4.map((a) => [a.characterId, a.voiceName]));
assert(byId.get("su") === "female-shaonv", "首位角色应保留 AI 选择");
assert(byId.get("liu") !== "female-shaonv" && byId.get("liu")!.startsWith("female"), "非 NPC 撞色应重挑同性别音色");
assert(byId.get("dian") === "male-qn-qingse", "NPC 允许复用音色");

console.log("=== AI 音色分配校验测试通过 ===");
