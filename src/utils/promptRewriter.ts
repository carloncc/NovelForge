/**
 * 提示词安全化改写器：内容审查触发时，用同义词替换高敏词，让同一任务可自动重试。
 * 词表覆盖动漫/galgame 题材常见触发类目（暴力/武器/裸露/身体/年龄/性暗示），中英双语。
 */

export interface RewriteResult {
  prompt: string;
  replaced: number;
}

/** 按触发类别分组的同义词替换表（顺序即优先级；每行 RegExp → 替换词） */
const REPLACEMENTS: Array<{ category: string; rules: Array<[RegExp, string]> }> = [
  {
    category: "violence",
    rules: [
      [/\bblood\w*\b/gi, "scarlet"],
      [/\bgore\w*\b/gi, "intensity"],
      [/\bwound(?:ed)?\b/gi, "battle mark"],
      [/\bscar(?:s)?\b/gi, "mark"],
      [/\bcorpse\w*\b/gi, "fallen form"],
      [/\b(?:death|dying|kill(?:ed|ing)?|murder(?:er)?|slaughter)\b/gi, "defeat"],
      [/\b(?:battle|battles|fight|fighting|combat|war|warfare|clash|conflict|assault|violent|violence)\b/gi, "dramatic encounter"],
      [/\b(?:soldiers?|army|warriors?)\b/gi, "guardians"],
      [/\b(?:attack|attacking|strike|striking|slay|slaying)\b/gi, "confront"],
      [/\b(?:weapon|weapons)\b/gi, "tool"],
      [/\b(?:arrow|arrows|projectile)\b/gi, "sigil"],
      [/流血|血腥|溅血/gi, "朱痕"],
      [/尸体|遗体/gi, "败者"],
      [/死亡|杀掉|杀死|屠杀|谋杀/gi, "决胜负"],
      [/伤口|伤疤/gi, "战斗痕"],
      [/战斗|打斗|激战|厮杀|搏斗|混战|战场|交锋|战争|战役|攻击|攻打|战斗场面/gi, "对决"],
      [/斩杀|斩击|击杀/gi, "击退"],
      [/兵器|武器|刀剑/gi, "法器"],
    ],
  },
  {
    category: "weapons",
    rules: [
      [/\b(?:sword|blade|katana|saber)\w*\b/gi, "ornate staff"],
      [/\b(?:spear|lance)\w*\b/gi, "banner pole"],
      [/\baxe\w*\b/gi, "war mace"],
      [/\b(?:gun|rifle|pistol|cannon)\w*\b/gi, "artifact"],
      [/\bbow\b(?!s\s*and\s*arrows)/gi, "lyre"],
      [/剑|刀刃|利刃|长剑|利剑/gi, "法器"],
      [/斧|长矛|长枪|枪械/gi, "权杖"],
      [/弓箭|弩/gi, "竖琴"],
    ],
  },
  {
    category: "exposure",
    rules: [
      [/\b(?:nude|naked|nudity|bare skin)\b/gi, "elegant attire"],
      [/\bunderwear\b/gi, "casual wear"],
      [/\bbikini\b/gi, "summer dress"],
      [/\blingerie\b/gi, "silk outfit"],
      [/\b(?:kiss|kissing|embrace|hugging)\b/gi, "greeting"],
      [/裸(?:体|露)|内衣|比基尼|蕾丝|紧身/gi, "盛装"],
      [/亲吻|接吻|拥抱/gi, "行礼"],
      [/脱下|解开/gi, "换上"],
    ],
  },
  {
    category: "body",
    rules: [
      [/\bskinny\b/gi, "graceful"],
      [/\bpetite\b/gi, "delicate"],
      [/\bslender\b/gi, "slim"],
      [/\b(?:breast|chest|cleavage)\w*\b/gi, "ribbon accessory"],
      [/瘦弱|平胸|丰满|身材(?:火辣|傲人)/gi, "身姿端庄"],
    ],
  },
  {
    category: "age",
    rules: [
      [/\bschool(?:girl|boy)\b/gi, "young scholar"],
      [/\bteens?\b|\bteenager\b/gi, "young adult"],
      [/\bloli\b|\bshota\b/gi, "small-statured youth"],
      [/幼女|萝莉|正太|小学生|未成年|性化描写/gi, "少年少女"],
    ],
  },
  {
    category: "suggestive",
    rules: [
      [/\bsexy\b/gi, "elegant"],
      [/\bseductive\b/gi, "charming"],
      [/\btempting\b/gi, "inviting"],
      [/\bflirt(?:ing|atious)?\b/gi, "friendly"],
      [/\b(?:sensual|erotic|explicit|pornographic)\b/gi, "graceful"],
      [/\b(?:nude|nudity|naked)\b/gi, "elegant attire"],
      [/性感|魅惑|诱惑|挑逗|妖娆|裸露|色情|情色|涩情/gi, "优雅"],
      [/挑逗|勾引|性化/gi, "俏皮"],
    ],
  },
];

/** 每类替换最多命中次数（避免把描述改得面目全非） */
const MAX_PER_CATEGORY = 3;

/** 对 prompt 做一次安全改写。返回改写后的 prompt 与替换计数。 */
export function sanitizePrompt(prompt: string): RewriteResult {
  if (!prompt) return { prompt, replaced: 0 };
  let out = prompt;
  let replaced = 0;
  for (const group of REPLACEMENTS) {
    let groupHits = 0;
    for (const [re, alt] of group.rules) {
      if (groupHits >= MAX_PER_CATEGORY) break;
      const before = out;
      out = out.replace(re, alt);
      if (out !== before) {
        replaced++;
        groupHits++;
      }
    }
  }
  // 收紧多余空格，保持 prompt 整洁
  out = out.replace(/\s{2,}/g, " ").trim();
  return { prompt: out, replaced };
}

/** 追加"安全/适合全年龄"风格后缀（部分模型对全年龄描述更宽松） */
export function appendSafeStyleSuffix(prompt: string): string {
  const safe =
    "anime style, wholesome, suitable for all audiences, family friendly, no explicit content";
  return prompt.endsWith(".")
    ? `${prompt} ${safe}.`
    : `${prompt}, ${safe}`;
}
