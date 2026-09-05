/**
 * MiniMax 官方系统音色（中文普通话 + 粤语，含性别/标签）。
 * 数据来源：MiniMax 开放平台「系统音色列表」文档（https://platform.minimaxi.com/docs/faq/system-voice-id）。
 * 用于配置页音色库、角色卡音色选择与 AI 提取时的音色候选。
 */

export interface MiniMaxVoice {
  id: string;
  name: string;
  gender: "male" | "female" | "other";
  lang: string;
  /** 中文标签（如 甜美/御姐/青年），供搜索与 AI 匹配 */
  tags: string[];
}

export const MINIMAX_SYSTEM_VOICES: MiniMaxVoice[] = [
  { id: "male-qn-qingse", name: "青涩青年音色", gender: "male", lang: "zh", tags: ["青年", "青涩", "男"] },
  { id: "male-qn-jingying", name: "精英青年音色", gender: "male", lang: "zh", tags: ["精英", "干练", "男"] },
  { id: "male-qn-badao", name: "霸道青年音色", gender: "male", lang: "zh", tags: ["霸道", "磁性", "男"] },
  { id: "male-qn-daxuesheng", name: "青年大学生音色", gender: "male", lang: "zh", tags: ["青年", "阳光", "男"] },
  { id: "female-shaonv", name: "少女音色", gender: "female", lang: "zh", tags: ["少女", "甜美", "女"] },
  { id: "female-yujie", name: "御姐音色", gender: "female", lang: "zh", tags: ["御姐", "慵懒", "女"] },
  { id: "female-chengshu", name: "成熟女性音色", gender: "female", lang: "zh", tags: ["成熟", "知性", "女"] },
  { id: "female-tianmei", name: "甜美女性音色", gender: "female", lang: "zh", tags: ["甜美", "温柔", "女"] },
  { id: "male-qn-qingse-jingpin", name: "青涩青年音色-beta", gender: "male", lang: "zh", tags: ["青年", "精品", "男"] },
  { id: "male-qn-jingying-jingpin", name: "精英青年音色-beta", gender: "male", lang: "zh", tags: ["精英", "精品", "男"] },
  { id: "male-qn-badao-jingpin", name: "霸道青年音色-beta", gender: "male", lang: "zh", tags: ["霸道", "精品", "男"] },
  { id: "male-qn-daxuesheng-jingpin", name: "青年大学生音色-beta", gender: "male", lang: "zh", tags: ["青年", "精品", "男"] },
  { id: "female-shaonv-jingpin", name: "少女音色-beta", gender: "female", lang: "zh", tags: ["少女", "精品", "女"] },
  { id: "female-yujie-jingpin", name: "御姐音色-beta", gender: "female", lang: "zh", tags: ["御姐", "精品", "女"] },
  { id: "female-chengshu-jingpin", name: "成熟女性音色-beta", gender: "female", lang: "zh", tags: ["成熟", "精品", "女"] },
  { id: "female-tianmei-jingpin", name: "甜美女性音色-beta", gender: "female", lang: "zh", tags: ["甜美", "精品", "女"] },
  { id: "clever_boy", name: "聪明男童", gender: "male", lang: "zh", tags: ["男童", "聪明"] },
  { id: "cute_boy", name: "可爱男童", gender: "male", lang: "zh", tags: ["男童", "可爱"] },
  { id: "lovely_girl", name: "萌萌女童", gender: "female", lang: "zh", tags: ["女童", "萌"] },
  { id: "cartoon_pig", name: "卡通猪小琪", gender: "other", lang: "zh", tags: ["卡通", "动物"] },
  { id: "bingjiao_didi", name: "病娇弟弟", gender: "male", lang: "zh", tags: ["病娇", "弟弟"] },
  { id: "junlang_nanyou", name: "俊朗男友", gender: "male", lang: "zh", tags: ["男友", "温柔"] },
  { id: "chunzhen_xuedi", name: "纯真学弟", gender: "male", lang: "zh", tags: ["学弟", "纯真"] },
  { id: "lengdan_xiongzhang", name: "冷淡学长", gender: "male", lang: "zh", tags: ["学长", "高冷"] },
  { id: "badao_shaoye", name: "霸道少爷", gender: "male", lang: "zh", tags: ["少爷", "霸道"] },
  { id: "tianxin_xiaoling", name: "甜心小玲", gender: "female", lang: "zh", tags: ["甜心", "活泼"] },
  { id: "qiaopi_mengmei", name: "俏皮萌妹", gender: "female", lang: "zh", tags: ["萌妹", "俏皮"] },
  { id: "wumei_yujie", name: "妩媚御姐", gender: "female", lang: "zh", tags: ["御姐", "妩媚"] },
  { id: "diadia_xuemei", name: "嗲嗲学妹", gender: "female", lang: "zh", tags: ["学妹", "嗲"] },
  { id: "danya_xuejie", name: "淡雅学姐", gender: "female", lang: "zh", tags: ["学姐", "淡雅"] },
  { id: "Chinese (Mandarin)_Reliable_Executive", name: "沉稳高管", gender: "male", lang: "zh", tags: ["高管", "沉稳", "男"] },
  { id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声", gender: "female", lang: "zh", tags: ["新闻", "播音", "女"] },
  { id: "Chinese (Mandarin)_Mature_Woman", name: "傲娇御姐", gender: "female", lang: "zh", tags: ["御姐", "傲娇"] },
  { id: "Chinese (Mandarin)_Unrestrained_Young_Man", name: "不羁青年", gender: "male", lang: "zh", tags: ["青年", "不羁", "男"] },
  { id: "Arrogant_Miss", name: "嚣张小姐", gender: "female", lang: "zh", tags: ["小姐", "嚣张"] },
  { id: "Robot_Armor", name: "机械战甲", gender: "other", lang: "zh", tags: ["机械", "机器人"] },
  { id: "Chinese (Mandarin)_Kind-hearted_Antie", name: "热心大婶", gender: "female", lang: "zh", tags: ["大婶", "热心"] },
  { id: "Chinese (Mandarin)_HK_Flight_Attendant", name: "港普空姐", gender: "female", lang: "zh", tags: ["空姐", "港普"] },
  { id: "Chinese (Mandarin)_Humorous_Elder", name: "搞笑大爷", gender: "male", lang: "zh", tags: ["大爷", "幽默"] },
  { id: "Chinese (Mandarin)_Gentleman", name: "温润男声", gender: "male", lang: "zh", tags: ["温润", "男"] },
  { id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜", gender: "female", lang: "zh", tags: ["闺蜜", "温暖"] },
  { id: "Chinese (Mandarin)_Male_Announcer", name: "播报男声", gender: "male", lang: "zh", tags: ["播音", "浑厚", "男"] },
  { id: "Chinese (Mandarin)_Sweet_Lady", name: "甜美女声", gender: "female", lang: "zh", tags: ["甜美", "治愈", "女"] },
  { id: "Chinese (Mandarin)_Southern_Young_Man", name: "南方小哥", gender: "male", lang: "zh", tags: ["青年", "南方"] },
  { id: "Chinese (Mandarin)_Wise_Women", name: "阅历姐姐", gender: "female", lang: "zh", tags: ["姐姐", "阅历"] },
  { id: "Chinese (Mandarin)_Gentle_Youth", name: "温润青年", gender: "male", lang: "zh", tags: ["青年", "温润", "男"] },
  { id: "Chinese (Mandarin)_Warm_Girl", name: "温暖少女", gender: "female", lang: "zh", tags: ["少女", "温暖"] },
  { id: "Chinese (Mandarin)_Kind-hearted_Elder", name: "花甲奶奶", gender: "female", lang: "zh", tags: ["奶奶", "慈祥"] },
  { id: "Chinese (Mandarin)_Cute_Spirit", name: "憨憨萌兽", gender: "other", lang: "zh", tags: ["萌兽", "可爱"] },
  { id: "Chinese (Mandarin)_Radio_Host", name: "电台男主播", gender: "male", lang: "zh", tags: ["主播", "磁性", "男"] },
  { id: "Chinese (Mandarin)_Lyrical_Voice", name: "抒情男声", gender: "male", lang: "zh", tags: ["抒情", "感染力", "男"] },
  { id: "Chinese (Mandarin)_Straightforward_Boy", name: "率真弟弟", gender: "male", lang: "zh", tags: ["弟弟", "率真"] },
  { id: "Chinese (Mandarin)_Sincere_Adult", name: "真诚青年", gender: "male", lang: "zh", tags: ["青年", "真诚"] },
  { id: "Chinese (Mandarin)_Gentle_Senior", name: "温柔学姐", gender: "female", lang: "zh", tags: ["学姐", "温柔"] },
  { id: "Chinese (Mandarin)_Stubborn_Friend", name: "嘴硬竹马", gender: "male", lang: "zh", tags: ["竹马", "嘴硬"] },
  { id: "Chinese (Mandarin)_Crisp_Girl", name: "清脆少女", gender: "female", lang: "zh", tags: ["少女", "清脆"] },
  { id: "Chinese (Mandarin)_Pure-hearted_Boy", name: "清澈邻家弟弟", gender: "male", lang: "zh", tags: ["弟弟", "清澈"] },
  { id: "Chinese (Mandarin)_Soft_Girl", name: "柔和少女", gender: "female", lang: "zh", tags: ["少女", "柔和"] },
  // 粤语
  { id: "Cantonese_ProfessionalHost（F)", name: "专业女主持(粤)", gender: "female", lang: "yue", tags: ["粤语", "主持", "女"] },
  { id: "Cantonese_GentleLady", name: "温柔女声(粤)", gender: "female", lang: "yue", tags: ["粤语", "温柔", "女"] },
  { id: "Cantonese_ProfessionalHost（M)", name: "专业男主持(粤)", gender: "male", lang: "yue", tags: ["粤语", "主持", "男"] },
  { id: "Cantonese_PlayfulMan", name: "活泼男声(粤)", gender: "male", lang: "yue", tags: ["粤语", "活泼", "男"] },
  { id: "Cantonese_CuteGirl", name: "可爱女孩(粤)", gender: "female", lang: "yue", tags: ["粤语", "可爱", "女"] },
  { id: "Cantonese_KindWoman", name: "善良女声(粤)", gender: "female", lang: "yue", tags: ["粤语", "善良", "女"] },
];

/** 中文系统音色 ID 列表（供模板 voices / AI 提取候选） */
export const MINIMAX_ZH_VOICE_IDS = MINIMAX_SYSTEM_VOICES.map((v) => v.id);

/** 按 ID 查找官方音色 */
export function minimaxVoiceById(id: string): MiniMaxVoice | undefined {
  return MINIMAX_SYSTEM_VOICES.find((v) => v.id === id);
}

/** 音色中文名：官方音色用中文名，克隆/设计音色回退 voiceId */
export function minimaxVoiceLabel(id: string): string {
  return minimaxVoiceById(id)?.name ?? id;
}
