/**
 * 阅读偏向决策 —— 纯函数，不调模型，不持久化
 *
 * 观察节点：10-07《皂罗袍》
 * 决策节点：10-08#0 入口（首次进入时冻结一次）
 *
 * 三维：spring / ruin / self
 * 证据：
 *   - 10-07 前的注意力选择（10-01#0 / 10-04#1 / 10-06#1）：0.5/次
 *   - 10-07 内第一处划线：1.5，仅一次（最强主动阅读证据）
 *   - 10-07#0 的 stage 选择：不计（发生在读《皂罗袍》之前，因果不成立）
 *   - 停留时间：本轮不入函数（store 未持久化）
 *
 * 分叉门槛（同时满足）：
 *   1. 至少两个独立行为证据
 *   2. 至少一个证据真实发生在 10-07（focal）
 *   3. confidence = (top - second) / total >= 0.25
 * 否则返回 neutral
 */
import type { AttentionMotif } from './types'
import type { Persisted } from './store'

export type ReadingBias = 'spring' | 'ruin' | 'self' | 'neutral'
export type FocalBias = Exclude<ReadingBias, 'neutral'>

export interface ReadingEvidence {
  id: string                 // 稳定 id，供规划模型引用（ev_01, ev_02...）
  beatId: string
  source: 'attention_choice' | 'start_marker' | 'underline'
  bias: FocalBias
  weight: number
  timestamp: number
  text?: string              // 划线的原文片段（attention_choice 无）
  motif?: string             // 原始 motif 标签
}

export interface ReadingBiasResult {
  bias: ReadingBias
  confidence: number
  evidence: ReadingEvidence[]
  scores: Record<FocalBias, number>   // 三维权重和，供规划模型参考
  decidedAt: '10-08#0'
}

// 10-07 之前允许计入的注意力选择 beat（不含 10-07#0，它在读《皂罗袍》之前发生）
const PRE_FOCAL_CHOICE_BEATS = new Set(['10-01#0', '10-04#1', '10-06#1'])
const FOCAL_SECTION = '10-07'
const FOCAL_BEAT = '10-07#0'
const DECISION_BEAT = '10-08#0' as const
const CONFIDENCE_THRESHOLD = 0.25

/** AttentionMotif → 三维偏向；dream 不计入（10-08 前无关） */
function motifToBias(motif: AttentionMotif): FocalBias | null {
  switch (motif) {
    case 'spring':
    case 'sound':
    case 'threshold':
      return 'spring'
    case 'ruin':
    case 'time':
      return 'ruin'
    case 'self':
    case 'desire':
      return 'self'
    case 'dream':
      return null
  }
}

// 复用 engine.ts 的词表逻辑（保持一致，避免双源维护）
const SPRING_LEX = ['春', '花', '园', '莺', '燕', '杜鹃', '荼蘼', '韶光', '姹紫嫣红', '良辰美景', '云霞', '烟波', '雨丝']
const RUIN_LEX = ['断井', '颓垣', '残', '冷', '废', '朽']
const SELF_LEX = ['妾身', '俺', '奴家', '全身', '颜色', '命', '锦屏人', '自己', '看', '贱']

function textToBias(text: string): FocalBias | null {
  let spring = 0, ruin = 0, self = 0
  for (const w of SPRING_LEX) if (text.includes(w)) spring++
  for (const w of RUIN_LEX) if (text.includes(w)) ruin++
  for (const w of SELF_LEX) if (text.includes(w)) self++
  const max = Math.max(spring, ruin, self)
  if (max === 0) return null
  if (spring === max && spring > ruin && spring > self) return 'spring'
  if (ruin === max && ruin > spring && ruin > self) return 'ruin'
  if (self === max && self > spring && self > ruin) return 'self'
  // 平局不入偏，避免武断
  return null
}

function pickDominant<T extends string>(arr: T[]): T | null {
  if (!arr.length) return null
  const counts: Record<string, number> = {}
  for (const x of arr) counts[x] = (counts[x] || 0) + 1
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null // 平局
  return sorted[0][0] as T
}

/**
 * 计算阅读偏向。纯函数：同一 state 必返回同一结果。
 * 调用方负责"首次进入 10-08#0 时调用一次，之后不重算"。
 */
export function deriveReadingBias(state: Persisted): ReadingBiasResult {
  const evidence: ReadingEvidence[] = []
  let evSeq = 0
  const nextEvId = () => `ev_${String(++evSeq).padStart(2, '0')}`

  // 1. 10-07 前的注意力选择：0.5/次
  const choices = state.attention?.recentChoices ?? []
  for (const choice of choices) {
    if (!PRE_FOCAL_CHOICE_BEATS.has(choice.beatId)) continue
    const biases = choice.motifs
      .map(motifToBias)
      .filter((b): b is FocalBias => b !== null)
    if (!biases.length) continue
    const bias = pickDominant(biases)
    if (!bias) continue
    evidence.push({
      id: nextEvId(),
      beatId: choice.beatId,
      source: 'attention_choice',
      bias,
      weight: 0.5,
      timestamp: choice.createdAt,
      motif: choice.motifs.join(','),
    })
  }

  // 2. 读者主动标记的“开始”：1.0，作为比注意力选择更强的判断证据
  const activeStart = (state.starts ?? []).find(s => s.active)
  if (activeStart) {
    const bias = textToBias(activeStart.text)
    if (bias) {
      evidence.push({
        id: nextEvId(),
        beatId: `${activeStart.sectionId}#start`,
        source: 'start_marker',
        bias,
        weight: 1.0,
        timestamp: activeStart.createdAt,
        text: activeStart.text,
      })
    }
  }

  // 3. 10-07 内第一处划线：1.5，仅一次
  const focalUnderline = (state.underlines ?? [])
    .filter(u => u.sectionId === FOCAL_SECTION)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (focalUnderline) {
    const bias = textToBias(focalUnderline.text)
    if (bias) {
      evidence.push({
        id: nextEvId(),
        beatId: FOCAL_BEAT,
        source: 'underline',
        bias,
        weight: 1.5,
        timestamp: focalUnderline.createdAt,
        text: focalUnderline.text,
      })
    }
  }

  // 4. 聚合权重
  const scores: Record<FocalBias, number> = { spring: 0, ruin: 0, self: 0 }
  for (const e of evidence) scores[e.bias] += e.weight
  const totalWeight = scores.spring + scores.ruin + scores.self
  const sorted = (Object.entries(scores) as [FocalBias, number][])
    .sort((a, b) => b[1] - a[1])
  const top = sorted[0]
  const second = sorted[1]
  const topWeight = top[1]
  const secondWeight = second[1]

  const confidence =
    totalWeight === 0 ? 0 : (topWeight - secondWeight) / totalWeight

  // 5. 门槛
  const hasEnoughEvidence = evidence.length >= 2
  const hasFocalEvidence = evidence.some(e => e.beatId === FOCAL_BEAT)

  if (
    !hasEnoughEvidence ||
    !hasFocalEvidence ||
    confidence < CONFIDENCE_THRESHOLD ||
    topWeight === 0
  ) {
    return { bias: 'neutral', confidence, evidence, scores, decidedAt: DECISION_BEAT }
  }

  return { bias: top[0], confidence, evidence, scores, decidedAt: DECISION_BEAT }
}
