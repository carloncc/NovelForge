import type { CharacterAction, CharacterCard, CharacterCostume, ExtractionResult, ItemCard, SceneCard } from "./types";
import { chatJson } from "../api/openaiCompatible";
import { inputCharBudgetForText, outputTokensForText } from "../api/providers";
import { voiceLibraryFor } from "../stores/config";
import { pickVoiceForGender, voiceGenderOf } from "./minimaxVoices";
import { normalizeEntityId } from "./ids";
import type { ApiConfig } from "./types";

const SYSTEM_PROMPT = `你是视觉小说制作人。从小说文本中提取制作视觉小说所需的结构化信息。
要求：
1. characters：所有有台词或推动剧情发展的人物都要提取，数量按剧情决定、不要人为设限（群像剧也不例外）。有台词但戏份少的次要角色/NPC（如店小二、守卫、丫鬟、路人等）也要提取，并标记 "isNpc": true。
   - id: 英文或拼音小写（如 linxiao），必须唯一
   - name: 中文姓名
   - appearance: 外貌描述（发型、眼睛、体型、气质）
   - clothing: 服装描述（颜色、款式）
   - personality: 性格特征
   - voiceDesc: 适合的音色描述（如"清冷的女声"）
   - gender: 角色性别，填 "male"（男）或 "female"（女）
   - voiceName: TTS 音色标识，必须从下面"可用音色列表"中选择最接近的一个，**且性别必须与角色的 gender 一致**（男性角色只能选男声音色，女性角色只能选女声音色；如果列表里没有匹配性别的，选该性别下最接近的；不要编造列表外的值）
    - imagePrompt: 用于 AI 绘画生成立绘的完整英文 prompt，只描述人物本身（全身像、服装、发型、表情）。构图必须是全身：prompt 里明确写 "full body, head to toe, entire figure in frame, shoes visible"，绝对不要写 "half body / portrait / close-up / waist-up / bust shot" 这类裁切构图词；姿态必须为自然放松站姿、双臂自然下垂，不要设计任何手势动作；禁止写任何背景/底色/场地/环境描述（系统会自动附加纯绿幕背景），风格统一为"动漫风格，精美立绘"
    - threeViewPrompt: 用于生成该角色"三视图参考图"（正面/侧面/背面）的完整英文 prompt：同一角色设定、站姿自然、表情平静、全身可见，同样禁止写任何背景/底色描述（系统会自动附加纯绿幕背景）。此图会作为该角色所有立绘/表情/动作的图生图参考，务必与人物的 imagePrompt 描述完全一致
    - actions: 该角色可能做出的经典自然动作（日常站姿/行走/坐姿/持物等真实姿态，用于动作立绘，基于三视图图生图，数量不限，按角色特点给出；不要设计夸张手势或凭空加手部动作）：
      - id: 简短英文标识（如 point/wave/cross/crouch/hold）
      - name: 动作中文名（如 抬手、挥手、抱臂、蹲下、持剑）
      - prompt: 该动作的完整英文 prompt，在保持人物外观（发型/服装/体型）完全一致的前提下描述动作姿态与表情（表情类动作如撒娇/鼓脸/微笑只描述面部表情，身体保持自然站姿、不要加任何手部动作），纯色背景，全身可见，动漫风格
   - costumes: 该角色的服装差分（用于换装演出与鉴赏室），数量按剧情决定、不设上限；剧情中出现换装的场景（如日常服、礼服、战斗服、睡衣等）都要收录；至少包含剧情主要服装：
     - id: 简短英文标识（如 casual/formal/battle/pajama）
     - name: 服装中文名（如 日常服、礼服、战斗服）
     - prompt: 该服装的完整英文 prompt，在保持人物外貌（发型/体型/五官）完全一致的前提下描述该服装的款式/颜色/材质，全身可见，纯色背景，动漫风格
   - emotions: 该角色剧情中实际需要的表情差分（英文小写 id，如 happy/sad/angry/surprised/shy/embarrassed/cry 等，控制在 6-10 个；不需要包含 normal）
   - color: 角色的主题色（十六进制，用于 UI）
   - isNpc: 布尔值。主要角色（有台词或推动剧情）填 false；次要角色/NPC（有台词但戏份少）填 true
2. scenes：故事中出现的地点场景（数量按剧情决定、不设上限）。
   - id: 唯一标识（如 classroom）
   - location: 地点名（如"城门前"）
   - atmosphere: 氛围（如"阴沉的黄昏"）
   - time: 时间
   - imagePrompt: 生成背景图的英文 prompt，无人物，动漫场景风格
3. items：重要的物品（获得、交接、使用的关键道具，数量按剧情决定、不设上限）。
   - id: 唯一标识
   - name: 物品名
   - appearance: 外观描述
   - note: 它在剧情中的意义
   - imagePrompt: 生成物品特写图的英文 prompt，居中构图，干净浅色背景

只输出 JSON，不要输出任何其他文字。`;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n……(截断)" : text;
}

/** 名称归一化（与 extractAgent.normalizeName 同口径；本文件内联避免循环依赖） */
function normName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, "");
}

/** id 查重：冲突按出现顺序加稳定后缀 _2/_3…（同一输入重复运行结果一致） */
function uniqueId(want: string, used: Set<string>): string {
  let id = want;
  let n = 2;
  while (used.has(id)) id = `${want}_${n++}`;
  used.add(id);
  return id;
}

/** 重复角色卡合并（本文件内实现，避免与 extractAgent 循环依赖）：
 * 先出现的卡为底，缺字段由后出现者补齐，动作/服装按 id 并集、表情按值并集 */
function mergeDupCharacter(target: CharacterCard, source: CharacterCard): void {
  for (const k of [
    "appearance", "clothing", "personality", "voiceDesc", "voiceName", "imagePrompt",
    "threeViewPrompt", "color", "gender", "voiceProfileId", "referenceImage", "referenceImagePath",
  ] as const) {
    if (!target[k] && source[k]) (target as unknown as Record<string, unknown>)[k] = source[k];
  }
  if (target.isNpc == null && source.isNpc != null) target.isNpc = source.isNpc;
  // 数组字段做 Array.isArray 防护：模型可能把数组写成字符串/对象，直接展开会抛错或清空已有数据
  const actionMap = new Map<string, CharacterAction>();
  for (const a of [
    ...(Array.isArray(target.actions) ? target.actions : []),
    ...(Array.isArray(source.actions) ? source.actions : []),
  ]) {
    if (a?.id && !actionMap.has(a.id)) actionMap.set(a.id, a);
  }
  if (actionMap.size || target.actions || source.actions) target.actions = [...actionMap.values()];
  const costumeMap = new Map<string, CharacterCostume>();
  for (const c of [
    ...(Array.isArray(target.costumes) ? target.costumes : []),
    ...(Array.isArray(source.costumes) ? source.costumes : []),
  ]) {
    if (c?.id && !costumeMap.has(c.id)) costumeMap.set(c.id, c);
  }
  if (costumeMap.size || target.costumes || source.costumes) target.costumes = [...costumeMap.values()];
  const emoSeen = new Set<string>();
  const emotions = [
    ...(Array.isArray(target.emotions) ? target.emotions : []),
    ...(Array.isArray(source.emotions) ? source.emotions : []),
  ].filter((e) => {
    if (typeof e !== "string" || !e || emoSeen.has(e)) return false;
    emoSeen.add(e);
    return true;
  });
  if (emotions.length || target.emotions || source.emotions) target.emotions = emotions;
}

/** 归一化提取结果：兜底空数组、缺 title 补标题、音色回退到列表首个、动作列表规范化。
 * 同时做基础去重：丢弃空 id/name 的残卡、id 查重（冲突加稳定后缀）、同名卡合并，
 * 防止同一角色/场景/物品出两张卡导致重复出图与配音计费。经典单次提取与 Agent 流程共用。 */
export function normalizeExtractionResult(result: ExtractionResult, lib: string[], title: string): ExtractionResult {
  if (!Array.isArray(result.characters)) throw new Error("提取结果缺少 characters 字段");
  result.scenes = Array.isArray(result.scenes) ? result.scenes : [];
  result.items = Array.isArray(result.items) ? result.items : [];
  result.title = result.title || title;

  {
    const usedIds = new Set<string>();
    const byName = new Map<string, CharacterCard>();
    const characters: CharacterCard[] = [];
    for (const raw of result.characters) {
      if (!raw || typeof raw !== "object") continue;
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!name || !id) continue; // 空 id/name 无法关联渲染与素材键，直接丢弃
      const key = normName(name);
      const hit = byName.get(key);
      if (hit) {
        mergeDupCharacter(hit, raw);
        continue;
      }
      const card: CharacterCard = { ...raw, id: uniqueId(id, usedIds), name };
      characters.push(card);
      byName.set(key, card);
    }
    result.characters = characters;
  }
  {
    const usedIds = new Set<string>();
    const byName = new Map<string, SceneCard>();
    const scenes: SceneCard[] = [];
    for (const raw of result.scenes) {
      if (!raw || typeof raw !== "object") continue;
      const location = typeof raw.location === "string" ? raw.location.trim() : "";
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!location || !id) continue;
      const key = normName(location);
      const hit = byName.get(key);
      if (hit) {
        for (const k of ["atmosphere", "time", "imagePrompt"] as const) {
          if (!hit[k] && raw[k]) hit[k] = raw[k];
        }
        continue;
      }
      const card: SceneCard = { ...raw, id: uniqueId(id, usedIds), location };
      scenes.push(card);
      byName.set(key, card);
    }
    result.scenes = scenes;
  }
  {
    const usedIds = new Set<string>();
    const byName = new Map<string, ItemCard>();
    const items: ItemCard[] = [];
    for (const raw of result.items) {
      if (!raw || typeof raw !== "object") continue;
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!name || !id) continue;
      const key = normName(name);
      const hit = byName.get(key);
      if (hit) {
        for (const k of ["appearance", "note", "imagePrompt"] as const) {
          if (!hit[k] && raw[k]) hit[k] = raw[k];
        }
        continue;
      }
      const card: ItemCard = { ...raw, id: uniqueId(id, usedIds), name };
      items.push(card);
      byName.set(key, card);
    }
    result.items = items;
  }

  for (const c of result.characters) {
    if (c.gender !== "male" && c.gender !== "female") {
      c.gender = /女|她|小姐|少女|母亲|奶奶|姐姐|妈妈|公主/i.test(c.appearance + c.name + c.personality) ? "female" : "male";
    }
    // 音色归一化：无效音色或性别不符（AI 选错/旧数据）→ 按角色性别从音色库稳定挑选；
    // 音色库无同性别候选时才退回列表首个（此前一律 lib[0]，默认列表首个是男声，女角色会拿到男声）
    const validVoice = c.voiceName && lib.includes(c.voiceName) ? c.voiceName : undefined;
    const voiceGender = validVoice ? voiceGenderOf(validVoice) : undefined;
    const mismatch = !!voiceGender && voiceGender !== "other" && !!c.gender && voiceGender !== c.gender;
    if (!validVoice || mismatch) {
      c.voiceName = pickVoiceForGender(lib, c.gender, c.id) || validVoice || lib[0] || c.voiceName || "default";
    }
    // 动作列表归一化：只保留 id/name/prompt 都合法的项（数量不限，按剧情提取）
    if (Array.isArray(c.actions)) {
      c.actions = c.actions
        .filter((a) => a && a.id && a.prompt)
        .map((a) => ({ id: normalizeEntityId(a.id, "a"), name: a.name || a.id, prompt: a.prompt }));
    }
    // 服装差分归一化：数量不限，按剧情提取
    if (Array.isArray(c.costumes)) {
      c.costumes = c.costumes
        .filter((ct) => ct && ct.id && ct.prompt)
        .map((ct) => ({ id: normalizeEntityId(ct.id, "ct"), name: ct.name || ct.id, prompt: ct.prompt }));
    }
    // 表情集归一化：只保留非空字符串、去重、上限 10（prompt 要求 6-10 个）；
    // 上限同时兜底模型超量返回导致立绘张数/费用暴涨
    if (Array.isArray(c.emotions)) {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const e of c.emotions) {
        if (typeof e !== "string") continue;
        const v = e.trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        cleaned.push(v);
      }
      c.emotions = cleaned.slice(0, 10);
    }
  }
  return result;
}

export async function extractFromNovel(
  cfg: ApiConfig,
  novelText: string,
  title: string,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
  voiceLib?: string[],
): Promise<ExtractionResult> {
  // 音色库来自 TTS 配置（由调用方传入）；缺省时回退到旧口径（按 cfg 推断，见 #788）
  const lib = voiceLib ?? voiceLibraryFor(cfg);
  const fb = feedback ? `\n\n用户对上一版提取结果的修改意见（请严格参考并落实）：${feedback}` : "";
  // 按性别标注音色，帮助 AI 给角色分配符合性别的音色（覆盖 MiniMax 官方表与常见音色名，不靠 ID 前缀猜）
  const genderedLib = lib
    .map((id) => {
      const g = voiceGenderOf(id);
      const label = g === "male" ? "（男）" : g === "female" ? "（女）" : "";
      return `${id}${label}`;
    })
    .join(", ");
  // 截断预算必须用「按文本语种估算 + 绝对上限」的变体：inputCharBudget 按 1 token≈1.5 字符（偏英文）
  // 粗估且上限高达 1,000,000 字符，对中文正文会高估约 2.5 倍（中文实际约 0.6~1.0 字符/token），
  // 上下文填大值时更会把近百万字符塞进一次请求（远超模型真实窗口）→ 网关截断/报错、提取质量崩。
  const user = `小说标题：${title}\n\n可用音色列表（已标注性别）：${genderedLib}\n\n请为每个角色挑选与其 gender 匹配性别的音色。${fb}\n\n以下是小说全文（按模型上下文动态截断，剩余部分将不被 LLM 看到）：\n${truncate(novelText, inputCharBudgetForText(cfg, novelText))}`;
  // 输出预算必须扣除输入估算（旧实现 min(context,32768) 在小上下文模型上 input+output 超上下文）
  const outputTokens = outputTokensForText(cfg, `${SYSTEM_PROMPT}\n${user}`);
  const result = await chatJson<ExtractionResult>(cfg, SYSTEM_PROMPT, user, { maxTokens: outputTokens, onUsage });
  return normalizeExtractionResult(result, lib, title);
}

export function demoExtract(novelText: string, title: string): ExtractionResult {
  const characters: CharacterCard[] = [
    {
      id: "linche",
      name: "林澈",
      appearance: "黑色短发，眼神锐利，身材修长，面容冷峻",
      clothing: "深蓝守夜人风衣，银色肩甲，黑色长靴",
      personality: "沉默寡言，重情重义，背负着守护城池的使命",
      voiceDesc: "低沉冷峻的男声",
      voiceName: "linche",
      imagePrompt:
        "anime style, full body portrait of a tall young man with short black hair and sharp eyes, wearing a dark blue night-watchman coat with silver shoulder armor and black boots, cold determined expression, standing pose, plain white background, clean illustration",
      threeViewPrompt:
        "anime style, three-view character reference sheet (front view / side view / back view) of a tall young man with short black hair and sharp eyes, dark blue night-watchman coat with silver shoulder armor and black boots, neutral standing pose, calm expression, full body visible, plain white background, clean illustration, same design in all three views",
      actions: [
        { id: "draw", name: "拔剑", prompt: "anime style, the tall young man in dark blue night-watchman coat with silver shoulder armor drawing a glowing blue sword from his back, fierce determined expression, dynamic stance, full body, plain white background, clean illustration" },
        { id: "point", name: "抬手", prompt: "anime style, the tall young man in dark blue night-watchman coat with silver shoulder armor pointing forward with one arm, commanding expression, full body, plain white background, clean illustration" },
        { id: "cross", name: "抱臂", prompt: "anime style, the tall young man in dark blue night-watchman coat with silver shoulder armor standing with arms crossed, cool confident expression, full body, plain white background, clean illustration" },
      ],
      color: "#3b5bdb",
    },
    {
      id: "suwanqing",
      name: "苏晚晴",
      appearance: "长发及腰，杏眼含星，气质温婉，身姿轻盈",
      clothing: "浅紫色长裙，白色披肩，玉簪挽发",
      personality: "温柔坚定，聪明勇敢，是城主之女",
      voiceDesc: "温柔清亮的少女声",
      voiceName: "suwanqing",
      imagePrompt:
        "anime style, full body portrait of a graceful young woman with long flowing hair and starry eyes, wearing a light purple long dress with white shawl and jade hairpin, gentle smile, standing pose, plain white background, clean illustration",
      threeViewPrompt:
        "anime style, three-view character reference sheet (front view / side view / back view) of a graceful young woman with long flowing hair and starry eyes, light purple long dress with white shawl and jade hairpin, neutral standing pose, calm gentle expression, full body visible, plain white background, clean illustration, same design in all three views",
      actions: [
        { id: "wave", name: "挥手", prompt: "anime style, the graceful young woman in light purple long dress with white shawl waving one hand in greeting, bright smile, full body, plain white background, clean illustration" },
        { id: "worry", name: "担忧", prompt: "anime style, the graceful young woman in light purple long dress with white shawl clasping her hands in front of her chest, worried expression, full body, plain white background, clean illustration" },
      ],
      color: "#9775fa",
    },
    {
      id: "tiejiang",
      name: "老铁匠",
      appearance: "花白胡须，皮肤黝黑，双手粗糙有力，体格魁梧",
      clothing: "粗布短褂，皮围裙",
      personality: "豪爽直率，技艺精湛",
      voiceDesc: "浑厚苍老的男声",
      voiceName: "tiejiang",
      imagePrompt:
        "anime style, full body portrait of an old muscular blacksmith with grey beard and tanned skin, wearing rough cloth jacket and leather apron, holding a hammer, warm smile, standing pose, plain white background, clean illustration",
      color: "#868e96",
    },
    {
      id: "xiaoer",
      name: "店小二",
      appearance: "圆脸，精明机灵，身量不高",
      clothing: "灰色短打，白色围裙，搭着一条毛巾",
      personality: "热情圆滑，消息灵通",
      voiceDesc: "年轻清亮的男声",
      voiceName: "xiaoer",
      isNpc: true,
      imagePrompt:
        "anime style, full body portrait of a young inn waiter with a round face and clever eyes, wearing a grey short jacket with a white apron and a towel over his shoulder, friendly smile, standing pose, plain white background, clean illustration",
      threeViewPrompt:
        "anime style, three-view character reference sheet (front view / side view / back view) of a young inn waiter with a round face and clever eyes, grey short jacket with white apron and towel over shoulder, neutral standing pose, calm friendly expression, full body visible, plain white background, clean illustration, same design in all three views",
      color: "#f08c00",
    },
  ];

  const scenes: SceneCard[] = [
    {
      id: "citygate",
      location: "城门前",
      atmosphere: "黄昏，暮色笼罩，寒风凛冽",
      time: "黄昏",
      imagePrompt:
        "anime background art, ancient city gate at dusk, towering stone walls, gloomy sky with orange sunset glow, cold wind feeling, distant mountains, no people, cinematic lighting",
    },
    {
      id: "forge",
      location: "铁匠铺",
      atmosphere: "炉火通红，铁器叮当，温暖而有烟火气",
      time: "夜晚",
      imagePrompt:
        "anime background art, a cozy blacksmith forge at night, glowing furnace with red flames, hanging iron tools and weapons on the wall, warm torchlight, wooden workbench, no people, cinematic lighting",
    },
    {
      id: "manor",
      location: "城主府",
      atmosphere: "庄严肃穆，灯火通明",
      time: "夜晚",
      imagePrompt:
        "anime background art, a grand lord manor hall at night, tall pillars, warm candlelight, red carpets and banners, majestic and solemn atmosphere, no people, cinematic lighting",
    },
  ];

  const items: ItemCard[] = [
    {
      id: "xingyun",
      name: "星陨剑",
      appearance: "剑身幽蓝如夜空，剑刃映着星光，剑柄缠着银色丝线",
      note: "传说中的神兵，传说曾在千年前击退魔潮",
      imagePrompt:
        "anime style item illustration, a legendary sword with a deep blue starry blade glowing with star light, silver wire wrapped hilt, centered composition, clean light gray background, product shot style",
    },
    {
      id: "yupai",
      name: "护心玉佩",
      appearance: "温润的白色玉佩，刻着云纹，系着红绳",
      note: "苏晚晴的信物，据说有守护之力",
      imagePrompt:
        "anime style item illustration, a warm white jade pendant with cloud patterns tied with red string, centered composition, clean light gray background, product shot style",
    },
  ];

  return { title, characters, scenes, items };
}
