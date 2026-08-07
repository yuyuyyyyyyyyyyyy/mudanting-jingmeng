// 余韵召回：复用 chapter10.json 中已人工审核的 echo 候选
// （目标句是已经审核过的"另一处原文"，AI 只能从这些里选）

export interface EchoCandidate {
  id: string
  targetText: string
  relation: string
}

export interface WhisperResult {
  echoId: string
  relation: string
  confidence: number
}

// 9 句皂罗袍 · 完整剧情弧：惊叹 → 疑问 → 铺陈 → 痛悟
export const GARDEN_LINES = [
  { id: 'L1', text: '原来姹紫嫣红开遍',      phase: '惊叹', pinyin: 'yuán lái chà zǐ yān hóng kāi biàn' },
  { id: 'L2', text: '似这般都付与断井颓垣',  phase: '惊叹', pinyin: 'sì zhè bān dōu fù yǔ duàn jǐng tuí yuán' },
  { id: 'L3', text: '良辰美景奈何天',          phase: '疑问', pinyin: 'liáng chén měi jǐng nài hé tiān' },
  { id: 'L4', text: '赏心乐事谁家院',          phase: '疑问', pinyin: 'shǎng xīn lè shì shéi jiā yuàn' },
  { id: 'L5', text: '朝飞暮卷',                phase: '铺陈', pinyin: 'zhāo fēi mù juǎn' },
  { id: 'L6', text: '云霞翠轩',                phase: '铺陈', pinyin: 'yún xiá cuì xuān' },
  { id: 'L7', text: '雨丝风片',                phase: '铺陈', pinyin: 'yǔ sī fēng piàn' },
  { id: 'L8', text: '烟波画船',                phase: '铺陈', pinyin: 'yān bō huà chuán' },
  { id: 'L9', text: '锦屏人忒看的这韶光贱',    phase: '痛悟', pinyin: 'jǐn píng rén tuī kàn de zhè sháo guāng jiàn' },
]

// 每个字的情绪偏向：spring=春/惊艳  ruin=残/痛  self=自照
// 用来统计读者停过哪些字，反过来决定画轴题字的色调
export type CharBias = 'spring' | 'ruin' | 'self'

export const CHAR_BIAS: Record<string, CharBias> = {
  // 惊叹·春
  原: 'spring', 来: 'spring', 姹: 'spring', 紫: 'spring',
  嫣: 'spring', 红: 'spring', 开: 'spring', 遍: 'spring',
  似: 'spring', 这: 'spring', 般: 'spring',
  // 惊叹·残
  都: 'ruin', 付: 'ruin', 与: 'ruin',
  断: 'ruin', 井: 'ruin', 颓: 'ruin', 垣: 'ruin',
  // 疑问·天
  良: 'spring', 辰: 'spring', 美: 'spring', 景: 'spring',
  奈: 'ruin', 何: 'ruin', 天: 'spring',
  // 疑问·谁
  赏: 'self', 心: 'self', 乐: 'self',
  事: 'self', 谁: 'self', 家: 'self', 院: 'self',
  // 痛悟
  锦: 'self', 屏: 'self', 人: 'self', 忒: 'self',
  看: 'self', 韶: 'self', 光: 'self', 贱: 'self',
  // 铺陈（备，未上一屏）
  朝: 'spring', 飞: 'spring', 暮: 'spring', 卷: 'spring',
  云: 'spring', 霞: 'spring', 翠: 'spring', 轩: 'self',
  雨: 'spring', 丝: 'spring', 风: 'spring', 片: 'spring',
  烟: 'spring', 波: 'spring', 画: 'self', 船: 'spring',
}

export function biasOfChar(ch: string): CharBias {
  return CHAR_BIAS[ch] || 'spring'
}

// 候选池：来自 chapter10.json 的 echoes
// 限制在 9 条，让 DeepSeek 在小池中挑
export const ECHO_CANDIDATES: EchoCandidate[] = [
  { id: 'e1', targetText: '原来姹紫嫣红开遍，似这般都付与断井颓垣', relation: '兑现' },
  { id: 'e2', targetText: '则为你如花美眷，似水流年', relation: '回应' },
  { id: 'e3', targetText: '有心情那梦儿还去不远', relation: '反转' },
  { id: 'e4', targetText: '是那处曾相见，相看俨然', relation: '对照' },
  { id: 'e5', targetText: '雨香云片，才到梦儿边', relation: '加深' },
  { id: 'e6', targetText: '可惜妾身颜色如花，岂料命如一叶乎', relation: '加深' },
  { id: 'e7', targetText: '不到园林，怎知春色如许', relation: '伏笔' },
  { id: 'e8', targetText: '蓦地游蜂搅翠烟，荡子来消渴', relation: '缘' },
  { id: 'e9', targetText: '梦短梦长皆是梦，年来年去不关春', relation: '归' },
]
