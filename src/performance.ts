import scoreData from '../public/data/performance-score.json'
import stagingData from '../public/data/staging-candidates.json'
import type {
  AttentionMotif,
  AttentionState,
  AttentionChoice,
  StagingCandidate,
  StagingBeat,
  StagingResolution,
} from './types'

export type PerformanceLead = 'guide' | 'stage' | 'original' | 'scene' | 'silence' | 'echo'
export type GuideMode = 'orient' | 'stage_cue' | 'echo_only' | 'silent' | 'entrance_only' | 'recall_only'

export interface PerformanceCue {
  id: string
  label: string
  from: string
  to: string
  lead: PerformanceLead
  visual: { bloom: number; density: number; motion: string; palette: string }
  music: { mode: string; intensity: number; motif: string; hardCut: boolean }
  guide: { mode: GuideMode; maxChars: number }
  thread: { node: string; action: string }
  entryCue: string | null
}

export interface PerformanceScore {
  chapterId: string
  title: string
  principle: string
  phases: PerformanceCue[]
}

export const performanceScore = scoreData as PerformanceScore

export function getPerformanceCue(sectionId: string, chapterOrder: string[]): PerformanceCue {
  const current = Math.max(0, chapterOrder.indexOf(sectionId))
  return performanceScore.phases.find(cue => {
    const from = chapterOrder.indexOf(cue.from)
    const to = chapterOrder.indexOf(cue.to)
    return current >= from && current <= to
  }) || performanceScore.phases[0]
}

export function isPhaseEntrance(sectionId: string, cue: PerformanceCue): boolean {
  return sectionId === cue.from
}

// ============================================================
// AI 演出调度 —— 《惊梦》两分钟闭环
// 产品定义：AI 不替你读懂《牡丹亭》，而是根据你在意的东西，为你调度这场演出。
// 这一层只决定「同一场演出如何来到读者面前」：先看见什么、哪个视觉层更明显、
// 先听见什么、原文停留多久、哪条旧句何时回来、画面何时展开或收束。
// 原文、情节、人物关系、结局全部由确定性程序控制，AI 不得改动。
// DeepSeek 只能在人工审核候选中返回一条 candidateId，不能返回 CSS、声音文件、
// 剧情或新文案。失败、超时或非法 JSON 时使用本地确定性排序兜底，绝不卡住阅读。
// ============================================================

export const ALL_MOTIFS: AttentionMotif[] = [
  'sound', 'self', 'spring', 'threshold',
  'ruin', 'dream', 'time', 'desire',
]

const RECENT_LIMIT = 12
const STAGE_TIMEOUT_MS = 4500

export interface StagingRegistry {
  chapterId: string
  beats: StagingBeat[]
  candidates: StagingCandidate[]
}

const stagingRegistry = stagingData as unknown as StagingRegistry

export function makeBeatId(sectionId: string, segmentIndex: number): string {
  return `${sectionId}#${segmentIndex}`
}

export function getStagingBeat(beatId: string): StagingBeat | undefined {
  return stagingRegistry.beats.find(b => b.beatId === beatId)
}

export function getCandidatesForBeat(beatId: string): StagingCandidate[] {
  return stagingRegistry.candidates.filter(c => c.beatId === beatId)
}

export function createAttentionState(): AttentionState {
  const weights = {} as Record<AttentionMotif, number>
  for (const m of ALL_MOTIFS) weights[m] = 0
  return { weights, recentChoices: [], dominantMotifs: [] }
}

export function normalizeAttentionState(raw: unknown): AttentionState {
  const base = createAttentionState()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<AttentionState>
  if (r.weights && typeof r.weights === 'object') {
    for (const m of ALL_MOTIFS) {
      const v = (r.weights as Record<string, unknown>)[m]
      base.weights[m] = Number.isFinite(v as number) ? (v as number) : 0
    }
  }
  if (Array.isArray(r.recentChoices)) {
    base.recentChoices = r.recentChoices
      .filter(c => c && typeof c.beatId === 'string' && typeof c.optionId === 'string')
      .slice(-RECENT_LIMIT)
      .map(c => ({
        beatId: String(c.beatId),
        optionId: String(c.optionId),
        motifs: Array.isArray(c.motifs) ? c.motifs.filter(m => ALL_MOTIFS.includes(m as AttentionMotif)) as AttentionMotif[] : [],
        createdAt: Number.isFinite(c.createdAt) ? (c.createdAt as number) : Date.now(),
      }))
  }
  base.dominantMotifs = computeDominantMotifs(base.weights)
  return base
}

export function applyAttentionChoice(
  state: AttentionState,
  beatId: string,
  optionId: string,
  motifs: AttentionMotif[],
): AttentionState {
  if (state.recentChoices.some(c => c.beatId === beatId)) return state
  const choice: AttentionChoice = { beatId, optionId, motifs, createdAt: Date.now() }
  const weights = { ...state.weights }
  for (const m of motifs) weights[m] = (weights[m] || 0) + 1
  const recentChoices = [...state.recentChoices, choice].slice(-RECENT_LIMIT)
  return { weights, recentChoices, dominantMotifs: computeDominantMotifs(weights) }
}

export function computeDominantMotifs(weights: Record<AttentionMotif, number>): AttentionMotif[] {
  const entries = ALL_MOTIFS.map(m => ({ m, w: weights[m] || 0 })).filter(e => e.w > 0).sort((a, b) => b.w - a.w)
  if (!entries.length) return []
  const top = entries[0].w
  return entries.filter(e => e.w >= top).slice(0, 3).map(e => e.m)
}

export function localResolveCandidate(
  beatId: string,
  weights: Record<AttentionMotif, number>,
): StagingResolution | null {
  const candidates = getCandidatesForBeat(beatId)
  if (!candidates.length) return null
  let best: { candidate: StagingCandidate; score: number } | null = null
  for (const c of candidates) {
    let score = 0
    for (const m of c.motifs) score += weights[m] || 0
    if (score === 0) score = 0.001
    if (!best || score > best.score ||
      (score === best.score && c.priority > best.candidate.priority) ||
      (score === best.score && c.priority === best.candidate.priority && c.id < best.candidate.id)) {
      best = { candidate: c, score }
    }
  }
  if (!best) return null
  return { candidateId: best.candidate.id, candidate: best.candidate, confidence: 0.5, dominantMotifs: computeDominantMotifs(weights), source: 'local' }
}

export interface StageApiInput {
  chapterId: string
  beatId: string
  currentText: string
  recentChoices: AttentionChoice[]
  attentionWeights: Record<AttentionMotif, number>
  reviewedCandidates: StagingCandidate[]
}

export async function requestStagingCue(input: StageApiInput): Promise<StagingResolution> {
  const fallback = localResolveCandidate(input.beatId, input.attentionWeights)
  const allowedIds = new Set(input.reviewedCandidates.map(c => c.id))
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS)
    const response = await fetch('/api/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterId: input.chapterId,
        beatId: input.beatId,
        currentText: input.currentText,
        recentChoices: input.recentChoices.map(c => ({ optionId: c.optionId, motifs: c.motifs })),
        attentionWeights: input.attentionWeights,
        reviewedCandidates: input.reviewedCandidates.map(c => ({
          id: c.id, motifs: c.motifs, visualCue: c.visualCue, soundCue: c.soundCue, pace: c.pace,
        })),
      }),
      signal: controller.signal,
    })
    window.clearTimeout(timer)
    if (!response.ok) return fallback || emptyResolution()
    const data = await response.json()
    if (!data?.ok || data.source !== 'deepseek') return fallback || emptyResolution()
    const candidateId = String(data.candidateId || '')
    if (!allowedIds.has(candidateId)) return fallback || emptyResolution()
    const candidate = input.reviewedCandidates.find(c => c.id === candidateId)!
    const confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0))
    const dominant = Array.isArray(data.dominantMotifs)
      ? data.dominantMotifs.filter((m: unknown) => ALL_MOTIFS.includes(m as AttentionMotif)).slice(0, 3) as AttentionMotif[]
      : computeDominantMotifs(input.attentionWeights)
    return { candidateId, candidate, confidence, dominantMotifs: dominant, source: 'deepseek' }
  } catch {
    return fallback || emptyResolution()
  }
}

function emptyResolution(): StagingResolution {
  const baseline: StagingCandidate = {
    id: 'baseline', beatId: '', motifs: [],
    visualCue: 'baseline', soundCue: 'baseline', pace: 'flow',
    priority: 0, reviewed: true,
  }
  return { candidateId: 'baseline', candidate: baseline, confidence: 0, dominantMotifs: [], source: 'local' }
}

// ============================================================
// /api/plan —— 阅读路径规划
// 规则层已提取结构化行为证据；DeepSeek 在审核候选中规划下一步，
// 返回 candidateId + objective + basedOnEvidenceIds。
// 前端校验合法性，失败走 neutral 兜底。
// ============================================================
export interface PlanApiInput {
  beatId: string
  currentText: string
  bias: string
  confidence: number
  scores: Record<string, number>
  evidence: { id: string; source: string; bias: string; weight: number; text?: string; beatId: string }[]
  reviewedCandidates: StagingCandidate[]
}

export interface PlanResult {
  candidateId: string
  objective: 'deepen' | 'counterbalance' | 'hold_self' | 'neutral'
  basedOnEvidenceIds: string[]
  confidence: number
  reason: string
  source: 'deepseek' | 'local'
}

const PLAN_TIMEOUT_MS = 7000

export async function requestPlan(input: PlanApiInput): Promise<PlanResult> {
  const validCandidateIds = new Set(input.reviewedCandidates.map(c => c.id))
  const validEvidenceIds = new Set(input.evidence.map(e => e.id))
  const neutral: PlanResult = {
    candidateId: 'stage_adaptive_neutral',
    objective: 'neutral',
    basedOnEvidenceIds: [],
    confidence: 0,
    reason: '',
    source: 'local',
  }
  // 证据不足：规则层已判 neutral，直接走 neutral 候选，不调用模型
  if (input.bias === 'neutral') return neutral
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS)
    const response = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beatId: input.beatId,
        currentText: input.currentText,
        bias: input.bias,
        confidence: input.confidence,
        scores: input.scores,
        evidence: input.evidence,
        reviewedCandidates: input.reviewedCandidates.map(c => ({
          id: c.id, motifs: c.motifs, pace: c.pace, echoId: (c as StagingCandidate & { echoId?: string }).echoId,
        })),
      }),
      signal: controller.signal,
    })
    window.clearTimeout(timer)
    if (!response.ok) return neutral
    const data = await response.json()
    if (!data?.ok || data.source !== 'deepseek') return neutral
    const candidateId = String(data.candidateId || '')
    // 前端校验：candidateId 必须在审核候选内
    if (!validCandidateIds.has(candidateId)) return neutral
    // 前端校验：basedOnEvidenceIds 必须全部是真实证据 id
    const basedOnEvidenceIds = (Array.isArray(data.basedOnEvidenceIds) ? data.basedOnEvidenceIds : [])
      .map(String).filter(id => validEvidenceIds.has(id))
    const objective = ['deepen', 'counterbalance', 'hold_self', 'neutral'].includes(data.objective) ? data.objective : 'neutral'
    return {
      candidateId,
      objective,
      basedOnEvidenceIds,
      confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
      reason: String(data.reason || '').slice(0, 60),
      source: 'deepseek',
    }
  } catch {
    return neutral
  }
}

export function paceDelayMs(pace: 'flow' | 'hold' | 'linger', motion: boolean, readMs: number = 0): number {
  // readMs = 调用方根据「原文长度 + 今译长度」计算的阅读时间，已按字数封顶。
  // pace 基础时长留给「画面调度感知」「句子过渡」，阅读时长完全由文本量决定。
  if (!motion) {
    switch (pace) {
      case 'flow':   return 1600 + readMs;
      case 'hold':   return 2200 + readMs;
      case 'linger': return 3200 + readMs;
    }
  }
  switch (pace) {
    case 'flow':   return 1800 + Math.random() * 500 + readMs;   // 1.8–2.3s + 阅读
    case 'hold':   return 2600 + Math.random() * 700 + readMs;   // 2.6–3.3s + 阅读
    case 'linger': return 3800 + Math.random() * 1200 + readMs;  // 3.8–5.0s + 阅读
  }
}

export { stagingRegistry }