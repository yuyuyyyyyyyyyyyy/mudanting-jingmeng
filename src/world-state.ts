/**
 * 世界状态推导 —— 纯函数，不调模型，不持久化
 *
 * 读者用针脚"声明"自己认为的变化开始；世界随之在 UI / 文本 / 声音三层同步漂移。
 * 这是 Agent 工作的可见产物：AI 在排序候选时，世界也在用色彩与声音回应读者。
 *
 * 证据（只读两样，与 b-agent 一致，不读隐性行为）：
 *   1. 当前 active pin 的文本 —— 读者认定的"变化开始"
 *   2. 当前揭示段落的 stage —— 剧情相位（reality / dream / wake）
 *
 * dream 态由剧情 stage 强制触发（入梦即扭曲，不依赖 pin）；
 * 其余态由 pin 文本的阅读偏向决定，复用与 b-agent 一致的词表。
 *
 * 可独立测试：同一 (pinText, stage) 必返回同一结果。
 */
import type { StageMode } from './types'

export type WorldState = 'spring' | 'self' | 'ruin' | 'dream' | 'neutral'

export interface WorldStateResult {
  state: WorldState
  /** 落在右下角 trace area 的"读法字"，是读者这一路阅读的视觉签名 */
  traceGlyph: string
  /** 决策依据（用于事件日志，不直接展示给读者） */
  reason: 'pin_spring' | 'pin_self' | 'pin_ruin' | 'stage_dream' | 'stage_wake' | 'default'
}

// 词表与 b-agent / reading-bias 保持同源，避免双源分歧
const SPRING_LEX = [
  '姹紫嫣红', '良辰美景', '春色', '赏心乐事', '雨丝风片', '烟波画船',
  '云霞翠轩', '朝飞暮卷', '荼蘼', '杜鹃', '燕语', '莺歌', '游园', '春', '花', '景',
]
// 强春色符号（《皂罗袍》核心四字意象）：读者选含它的句子时，春色是视觉主体，
// 断井颓垣只是对照宾语。汤显祖写"春色付与衰败"，杜丽娘目光先落春色——故春色优先。
const SPRING_STRONG = ['姹紫嫣红', '良辰美景', '赏心乐事', '雨丝风片', '烟波画船', '云霞翠轩', '朝飞暮卷']
const SELF_LEX = [
  '锦屏人', '韶光贱', '颜色如花', '命如一叶', '幽闺', '如花美眷', '似水流年',
  '颜色', '命', '妾身', '奴家', '全身', '俺',
]
const RUIN_LEX = ['断井', '颓垣', '残', '冷', '废', '朽', '衰']

type Bias = 'spring' | 'self' | 'ruin'

function textToBias(text: string): Bias | null {
  let spring = 0, self = 0, ruin = 0
  for (const w of SPRING_LEX) if (text.includes(w)) spring++
  for (const w of SELF_LEX) if (text.includes(w)) self++
  for (const w of RUIN_LEX) if (text.includes(w)) ruin++
  // 强春色符号额外加权：避免"姹紫嫣红开遍付与断井颓垣"因断井+颓垣词数多而误判为衰败
  for (const w of SPRING_STRONG) if (text.includes(w)) spring += 2
  const max = Math.max(spring, self, ruin)
  if (max === 0) return null
  // 严格领先才入偏，平局保持中性（避免武断，与 reading-bias 一致）
  if (spring === max && spring > self && spring > ruin) return 'spring'
  if (self === max && self > spring && self > ruin) return 'self'
  if (ruin === max && ruin > spring && ruin > self) return 'ruin'
  return null
}

/** 从 pin 文本里取一个字，作为这一路阅读的视觉签名 */
function glyphFor(text: string, bias: Bias | null): string {
  if (!text) return '·'
  // 优先捕捉情感性字眼
  if (text.includes('梦') || text.includes('眠')) return '梦'
  if (text.includes('惊')) return '惊'
  if (bias === 'spring') return '春'
  if (bias === 'self') return '颜'
  if (bias === 'ruin') return '残'
  // 兜底：取 pin 第一个非空白字
  const ch = text.trim().charAt(0)
  return ch || '·'
}

/**
 * 推导当前世界状态。纯函数。
 * @param pinText 当前 active pin 的原文（无 pin 传 null）
 * @param stage   当前揭示到的最后一段的剧情相位
 */
export function deriveWorldState(
  pinText: string | null,
  stage: StageMode,
): WorldStateResult {
  // 1) 入梦：剧情强制扭曲，不依赖读者选择
  if (stage === 'dream') {
    return { state: 'dream', traceGlyph: '梦', reason: 'stage_dream' }
  }
  // 2) 梦醒：世界回归中性，但 trace 字保留（读者这一路读法的痕迹不消失）
  if (stage === 'wake') {
    const bias = pinText ? textToBias(pinText) : null
    return { state: 'neutral', traceGlyph: glyphFor(pinText || '', bias), reason: 'stage_wake' }
  }
  // 3) reality：由读者针脚的偏向决定
  if (!pinText) return { state: 'neutral', traceGlyph: '·', reason: 'default' }
  const bias = textToBias(pinText)
  if (bias === 'spring') return { state: 'spring', traceGlyph: glyphFor(pinText, bias), reason: 'pin_spring' }
  if (bias === 'self')   return { state: 'self',   traceGlyph: glyphFor(pinText, bias), reason: 'pin_self' }
  if (bias === 'ruin')   return { state: 'ruin',   traceGlyph: glyphFor(pinText, bias), reason: 'pin_ruin' }
  return { state: 'neutral', traceGlyph: glyphFor(pinText, null), reason: 'default' }
}

/**
 * 世界状态 → 声音 mode（供 setPerformanceMusic 使用）。
 * 读者选择扭曲声音世界：选"断井颓垣"则音乐低沉，选"姹紫嫣红"则明亮。
 */
export function worldToMusicMode(state: WorldState, stage: StageMode): string {
  if (stage === 'dream') return 'dream'
  if (stage === 'wake') return 'wake'
  switch (state) {
    case 'spring': return 'garden'   // 园林明亮
    case 'self':   return 'self'     // 自照收敛
    case 'ruin':   return 'chamber'  // 闺阁低沉
    default:       return 'garden'   // neutral 默认游园明亮
  }
}
