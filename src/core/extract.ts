import type { CharacterCard, ExtractionResult, ItemCard, SceneCard } from "./types";
import { chatJson } from "../api/openaiCompatible";
import { inputCharBudget, resolveContextLength } from "../api/providers";
import { voiceLibraryFor } from "../stores/config";
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
   - voiceName: TTS 音色标识，必须从下面"可用音色列表"中选择最接近的一个（如果没有完全匹配的，选最接近的；不要编造列表外的值）
   - imagePrompt: 用于 AI 绘画生成立绘的完整英文 prompt，只描述人物本身（全身像、服装、发型、表情、姿态），禁止写任何背景/底色/场地/环境描述（系统会自动附加纯绿幕背景），风格统一为"动漫风格，精美立绘"
   - threeViewPrompt: 用于生成该角色"三视图参考图"（正面/侧面/背面）的完整英文 prompt：同一角色设定、站姿自然、表情平静、全身可见，同样禁止写任何背景/底色描述（系统会自动附加纯绿幕背景）。此图会作为该角色所有立绘/表情/动作的图生图参考，务必与人物的 imagePrompt 描述完全一致
   - actions: 该角色可能做出的经典动作（用于动作立绘，基于三视图图生图，数量不限，按角色特点给出；动作多的角色可以多给）：
     - id: 简短英文标识（如 point/wave/cross/crouch/hold）
     - name: 动作中文名（如 抬手、挥手、抱臂、蹲下、持剑）
     - prompt: 该动作的完整英文 prompt，在保持人物外观（发型/服装/体型）完全一致的前提下描述动作姿态与表情，纯色背景，全身可见，动漫风格
   - color: 角色的主题色（十六进制，用于 UI）
   - isNpc: 布尔值。主要角色（有台词或推动剧情）填 false；次要角色/NPC（有台词但戏份少）填 true
2. scenes：故事中出现的地点场景（最多 12 个）。
   - id: 唯一标识（如 classroom）
   - location: 地点名（如"城门前"）
   - atmosphere: 氛围（如"阴沉的黄昏"）
   - time: 时间
   - imagePrompt: 生成背景图的英文 prompt，无人物，动漫场景风格
3. items：重要的物品（获得、交接、使用的关键道具，最多 10 个）。
   - id: 唯一标识
   - name: 物品名
   - appearance: 外观描述
   - note: 它在剧情中的意义
   - imagePrompt: 生成物品特写图的英文 prompt，居中构图，干净浅色背景

只输出 JSON，不要输出任何其他文字。`;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n……(截断)" : text;
}

/** 归一化提取结果：兜底空数组、缺 title 补标题、音色回退到列表首个、动作列表规范化。经典单次提取与 Agent 流程共用。 */
export function normalizeExtractionResult(result: ExtractionResult, lib: string[], title: string): ExtractionResult {
  if (!Array.isArray(result.characters)) throw new Error("提取结果缺少 characters 字段");
  result.scenes = result.scenes ?? [];
  result.items = result.items ?? [];
  result.title = result.title || title;
  for (const c of result.characters) {
    if (!c.voiceName || !lib.includes(c.voiceName)) {
      c.voiceName = lib[0] || c.voiceName || "default";
    }
    // 动作列表归一化：只保留 id/name/prompt 都合法的项（数量不限，按剧情提取）
    if (Array.isArray(c.actions)) {
      c.actions = c.actions
        .filter((a) => a && a.id && a.prompt)
        .map((a) => ({ id: String(a.id).toLowerCase().replace(/[^a-z0-9_-]/g, "_"), name: a.name || a.id, prompt: a.prompt }));
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
): Promise<ExtractionResult> {
  const lib = voiceLibraryFor(cfg);
  const fb = feedback ? `\n\n用户对上一版提取结果的修改意见（请严格参考并落实）：${feedback}` : "";
  const user = `小说标题：${title}\n\n可用音色列表：${lib.join(", ")}${fb}\n\n以下是小说全文（按模型上下文动态截断，剩余部分将不被 LLM 看到）：\n${truncate(novelText, inputCharBudget(cfg))}`;
  const outputTokens = Math.min(resolveContextLength(cfg), 240_000);
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
