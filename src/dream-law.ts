/**
 * 司梦法则 —— 类型与确定性实现（不调模型）
 *
 * 核心原则：AI 负责理解和判断，代码负责守法。
 * 窗口定上限，证据定实际；无证据时即使门全开也必须不进。
 * 深度下降后，只能使用明确获准该深度出现的舞台转译；任何降级版本必须事先单独生成、单独引用证据、单独通过兼容性判断。
 */

export type Layer = 'sound' | 'space' | 'scene' | 'action' | 'narration'
export type Depth = 'none' | 'mirror' | 'merge' | 'enter'

const DEPTH_ORDER: ReadonlyArray<Depth> = ['none', 'mirror', 'merge', 'enter']

export type WindowKey =
  | 'enter_garden'
  | 'spring_full'
  | 'spring_fading'
  | 'boundary_soft'
  | 'dream_enter'
  | 'awaken'

export type EvidenceKind =
  | 'person' | 'place' | 'object' | 'action' | 'event' | 'explicit_emotion'

// —— 证据层：原话 + 精确位置 ——
export interface EvidenceSpan {
  id: string
  text: string
  start: number
  end: number
  kind: EvidenceKind
}

// —— 舞台转译：单一 depth，禁止跨深度复用 ——
export interface StageAffordance {
  id: string
  value: string
  layer: Layer
  depth: Exclude<Depth, 'none'>
  derivedFrom: string[]
  transformation: string
}

export interface DreamMemory {
  rawText: string
  evidence: EvidenceSpan[]
  affordances: StageAffordance[]
  forbiddenExamples: string[]
}

// —— 窗口：区分 entry 与 exit_only ——
export type WindowMode =
  | { kind: 'entry'; maxDepth: Depth }
  | { kind: 'exit_only'; residueAllowed: boolean }

export interface DramaWindow {
  key: WindowKey
  label: string
  mode: WindowMode
  originalDensity: 'high' | 'mid' | 'low'
  semanticOpenness: 'closed' | 'gap' | 'open'
  characterOwnership: 'strong' | 'mid' | 'weak'
}

export const WINDOWS: Record<WindowKey, DramaWindow> = {
  enter_garden:  { key: 'enter_garden',  label: '初入园',         mode: { kind: 'entry', maxDepth: 'mirror' }, originalDensity: 'mid',  semanticOpenness: 'gap',  characterOwnership: 'mid'   },
  spring_full:   { key: 'spring_full',   label: '姹紫嫣红开遍',   mode: { kind: 'entry', maxDepth: 'none'   }, originalDensity: 'high', semanticOpenness: 'closed', characterOwnership: 'strong' },
  spring_fading: { key: 'spring_fading', label: '良辰美景奈何天', mode: { kind: 'entry', maxDepth: 'merge'  }, originalDensity: 'mid',  semanticOpenness: 'gap',  characterOwnership: 'strong' },
  boundary_soft: { key: 'boundary_soft', label: '现实边界松动',   mode: { kind: 'entry', maxDepth: 'merge'  }, originalDensity: 'low',  semanticOpenness: 'open',  characterOwnership: 'weak'   },
  dream_enter:   { key: 'dream_enter',   label: '正式入梦',       mode: { kind: 'entry', maxDepth: 'enter'  }, originalDensity: 'low',  semanticOpenness: 'open',  characterOwnership: 'weak'   },
  awaken:        { key: 'awaken',        label: '惊醒',           mode: { kind: 'exit_only', residueAllowed: true }, originalDensity: 'high', semanticOpenness: 'closed', characterOwnership: 'strong' },
}

// —— 兼容性判断：逐项评估 ——
export interface AffordanceAssessment {
  affordanceId: string
  grounding: 'supported' | 'requires_invention' | 'conflicts'
  sensoryBridge: 'none' | 'weak' | 'strong'
  spatialBridge: 'none' | 'weak' | 'strong'
  actionBridge: 'none' | 'weak' | 'strong'
  allowedLayers: Layer[]
  evidenceIds: string[]
  reason: string
}

export interface CompatibilityReason {
  claim: string
  evidenceIds: string[]
  windowField: 'originalDensity' | 'semanticOpenness' | 'characterOwnership'
}

export interface CompatibilityAssessment {
  perAffordance: AffordanceAssessment[]
  originalConflict: 'low' | 'mid' | 'high'
  characterIntrusionRisk: 'low' | 'mid' | 'high'
  reasons: CompatibilityReason[]
}

// —— 用户回应：区分 none 与 silence ——
export type UserResponse =
  | { kind: 'none' }
  | { kind: 'affirm'; rawText: string }
  | { kind: 'decline'; rawText: string }
  | { kind: 'new_evidence'; rawText: string }
  | { kind: 'silence' }

// —— 状态：许可与拒绝持久化 ——
export type EntryConsent = 'unknown' | 'granted' | 'denied'

export interface DreamState {
  currentDepth: Depth
  activeAffordanceIds: string[]
  appearedAffordanceIds: string[]
  previousDecision?: DreamDecision
  interventionCount: number
  hasFormallyEntered: boolean
  entryConsent: EntryConsent
  declineSignal: boolean
  silenceCount: number
}

export function initialDreamState(): DreamState {
  return {
    currentDepth: 'none',
    activeAffordanceIds: [],
    appearedAffordanceIds: [],
    interventionCount: 0,
    hasFormallyEntered: false,
    entryConsent: 'unknown',
    declineSignal: false,
    silenceCount: 0,
  }
}

export interface DecisionBasis {
  reason: string
  evidenceIds: string[]
}

export interface LayerUse {
  layer: Layer
  affordanceId: string
  evidenceIds: string[]
}

// withhold 带 nextDepth，不再矛盾；fade 升格为 exit 的 mode
export type WithholdEffect = 'keep' | 'clear'

export type DreamDecision =
  | { kind: 'withhold'; windowKey: WindowKey; effect: WithholdEffect;
      nextDepth: Depth; nextActiveIds: string[]; basis: DecisionBasis }
  | { kind: 'present'; windowKey: WindowKey; depth: 'mirror' | 'merge' | 'enter';
      layers: LayerUse[]; duration: 'instant' | 'segment' | 'until_next';
      exitPlan: 'fade' | 'covered' | 'hold'; basis: DecisionBasis }
  | { kind: 'exit'; windowKey: WindowKey; exitMode: 'fade' | 'cut';
      fromDepth: Depth; fromAffordanceIds: string[];
      residue?: LayerUse; basis: DecisionBasis }

// ============================================================
// 确定性函数
// ============================================================

export function deeperThan(a: Depth, b: Depth): boolean {
  return DEPTH_ORDER.indexOf(a) > DEPTH_ORDER.indexOf(b)
}

export function stepToward(from: Depth, target: Depth): Depth {
  const fi = DEPTH_ORDER.indexOf(from)
  const ti = DEPTH_ORDER.indexOf(target)
  if (ti > fi) return DEPTH_ORDER[Math.min(DEPTH_ORDER.length - 1, fi + 1)]
  if (ti < fi) return DEPTH_ORDER[Math.max(0, fi - 1)]
  return from
}

export function applyResponseToState(state: DreamState, response: UserResponse): DreamState {
  switch (response.kind) {
    case 'affirm':       return { ...state, entryConsent: 'granted', silenceCount: 0 }
    case 'decline':      return { ...state, entryConsent: 'denied', declineSignal: true, silenceCount: 0 }
    case 'new_evidence': return state
    case 'silence':      return { ...state, silenceCount: state.silenceCount + 1 }
    case 'none':         return state
  }
}

// 步骤2：验证证据位置与来源链
export function validateMemoryEvidence(memory: DreamMemory): boolean {
  const { rawText, evidence, affordances } = memory
  for (const e of evidence) {
    if (e.start < 0 || e.end <= e.start) return false
    if (rawText.slice(e.start, e.end) !== e.text) return false
  }
  const ids = new Set(evidence.map(e => e.id))
  for (const a of affordances) {
    if (!a.derivedFrom.length) return false
    if (!a.derivedFrom.every(id => ids.has(id))) return false
  }
  return true
}

// 步骤4：验证评估引用与权限
export function validateAssessment(
  assessment: CompatibilityAssessment,
  memory: DreamMemory,
): boolean {
  const affordanceIds = new Set(memory.affordances.map(a => a.id))
  const evidenceIds = new Set(memory.evidence.map(e => e.id))
  for (const pa of assessment.perAffordance) {
    if (!affordanceIds.has(pa.affordanceId)) return false
    if (!pa.evidenceIds || !pa.evidenceIds.length) return false
    if (!pa.evidenceIds || !pa.evidenceIds.every(id => evidenceIds.has(id))) return false
  }
  for (const r of assessment.reasons) {
    if (!r.evidenceIds || !r.evidenceIds.length) return false
    if (!r.evidenceIds || !r.evidenceIds.every(id => evidenceIds.has(id))) return false
  }
  return true
}

function hasSustainableGroundedAffordance(
  memory: DreamMemory,
  assessment: CompatibilityAssessment,
): boolean {
  const supported = assessment.perAffordance.filter(
    pa => pa.grounding === 'supported' &&
          pa.allowedLayers.some(l => l === 'scene' || l === 'space' || l === 'action')
  )
  return memory.affordances.some(a =>
    supported.some(pa => pa.affordanceId === a.id) && a.depth === 'enter'
  )
}

export function supportsSceneEntry(
  memory: DreamMemory,
  assessment: CompatibilityAssessment,
  state: DreamState,
): boolean {
  return (
    state.entryConsent === 'granted' &&
    assessment.originalConflict !== 'high' &&
    assessment.characterIntrusionRisk === 'low' &&
    hasSustainableGroundedAffordance(memory, assessment)
  )
}

function decideDepth(
  window: DramaWindow,
  state: DreamState,
  assessment: CompatibilityAssessment,
  response: UserResponse,
  memory: DreamMemory,
): Depth {
  if (window.mode.kind !== 'entry') return 'none'
  const maxDepth = window.mode.maxDepth
  if (maxDepth === 'none') return 'none'

  const supported = assessment.perAffordance.filter(pa => pa.grounding === 'supported')
  if (supported.length === 0) return 'none'

  let target: Depth = 'none'
  for (const pa of supported) {
    const aff = memory.affordances.find(a => a.id === pa.affordanceId)
    if (!aff) continue
    if (deeperThan(aff.depth, target)) target = aff.depth
  }
  if (target === 'none') return 'none'

  if (deeperThan(target, maxDepth)) target = maxDepth

  if (window.key !== 'dream_enter') {
    target = stepToward(state.currentDepth, target)
  }

  if (response.kind === 'silence' && deeperThan(target, state.currentDepth)) {
    target = state.currentDepth
  }

  if (window.key === 'dream_enter' && target === 'enter') {
    if (!supportsSceneEntry(memory, assessment, state)) {
      target = 'merge'
    }
  }
  return target
}

// 三重验证：grounding + 精确深度 + allowedLayers
function pickAffordancesForDepth(
  targetDepth: Exclude<Depth, 'none'>,
  assessment: CompatibilityAssessment,
  memory: DreamMemory,
): StageAffordance[] {
  const assessmentById = new Map(
    assessment.perAffordance.map(item => [item.affordanceId, item]),
  )
  return memory.affordances.filter(affordance => {
    const item = assessmentById.get(affordance.id)
    return (
      item?.grounding === 'supported' &&
      affordance.depth === targetDepth &&
      item.allowedLayers.includes(affordance.layer)
    )
  })
}

function pickLightestResidue(
  memory: DreamMemory,
  assessment: CompatibilityAssessment,
  state: DreamState,
): LayerUse | undefined {
  const byId = new Map(memory.affordances.map(a => [a.id, a]))
  const paById = new Map(assessment.perAffordance.map(pa => [pa.affordanceId, pa]))
  for (const id of state.appearedAffordanceIds) {
    const a = byId.get(id); const pa = paById.get(id)
    if (a && pa && pa.grounding === 'supported' && pa.allowedLayers.includes('sound')) {
      return { layer: 'sound', affordanceId: id, evidenceIds: a.derivedFrom }
    }
  }
  return undefined
}

function buildBasis(
  assessment: CompatibilityAssessment,
  used: StageAffordance[],
): DecisionBasis {
  const evidenceIds = Array.from(new Set(used.flatMap(a => a.derivedFrom)))
  const reason = assessment.reasons[0]?.claim ?? '依据兼容性判断'
  return { reason, evidenceIds }
}

// 步骤5：applyDreamLaw —— 法则状态机，严格按优先级
export function applyDreamLaw(
  memory: DreamMemory,
  window: DramaWindow,
  state: DreamState,
  response: UserResponse,
  assessment: CompatibilityAssessment,
): DreamDecision {

  // 优先级1：惊醒 —— 强制退出
  if (window.mode.kind === 'exit_only') {
    return {
      kind: 'exit',
      windowKey: window.key,
      exitMode: 'cut',
      fromDepth: state.currentDepth,
      fromAffordanceIds: state.activeAffordanceIds,
      residue: window.mode.residueAllowed
        ? pickLightestResidue(memory, assessment, state)
        : undefined,
      basis: { reason: '惊醒切断，记忆必须退出', evidenceIds: [] },
    }
  }

  // 优先级2：用户明确拒绝 —— 渐退退出
  if (state.declineSignal) {
    return {
      kind: 'exit',
      windowKey: window.key,
      exitMode: 'fade',
      fromDepth: state.currentDepth,
      fromAffordanceIds: state.activeAffordanceIds,
      basis: { reason: '用户明确拒绝，渐退', evidenceIds: [] },
    }
  }

  // 优先级3：窗口硬权限 —— maxDepth none，原作占满
  if (window.mode.maxDepth === 'none') {
    return {
      kind: 'withhold', windowKey: window.key, effect: 'clear',
      nextDepth: 'none', nextActiveIds: [],
      basis: { reason: '原作占满舞台，已有记忆被覆盖', evidenceIds: [] },
    }
  }

  // 优先级4：证据合法性
  const supported = assessment.perAffordance.filter(pa => pa.grounding === 'supported')
  if (supported.length === 0) {
    if (state.currentDepth === 'none') {
      return { kind: 'withhold', windowKey: window.key, effect: 'keep',
               nextDepth: 'none', nextActiveIds: [],
               basis: { reason: '无原话证据可用', evidenceIds: [] } }
    }
    return {
      kind: 'exit', windowKey: window.key, exitMode: 'fade',
      fromDepth: state.currentDepth, fromAffordanceIds: state.activeAffordanceIds,
      basis: { reason: '无原话证据可用，已有记忆渐退', evidenceIds: [] },
    }
  }

  // 优先级5：原作边界
  if (window.originalDensity === 'high' && window.characterOwnership === 'strong') {
    return {
      kind: 'withhold', windowKey: window.key, effect: 'clear',
      nextDepth: 'none', nextActiveIds: [],
      basis: { reason: '原作意象完整，角色归属强', evidenceIds: [] },
    }
  }

  // 优先级6：先决定深度
  const targetDepth = decideDepth(window, state, assessment, response, memory)
  if (targetDepth === 'none') {
    if (state.currentDepth !== 'none') {
      return {
        kind: 'exit', windowKey: window.key, exitMode: 'fade',
        fromDepth: state.currentDepth, fromAffordanceIds: state.activeAffordanceIds,
        basis: { reason: '记忆质感与原作此刻不共存，渐退', evidenceIds: [] },
      }
    }
    return {
      kind: 'withhold', windowKey: window.key, effect: 'keep',
      nextDepth: 'none', nextActiveIds: [],
      basis: { reason: '记忆质感与原作此刻不共存', evidenceIds: [] },
    }
  }

  // 优先级7：按实际深度选素材（先深度后素材）
  const used = pickAffordancesForDepth(targetDepth as Exclude<Depth, 'none'>, assessment, memory)
  if (used.length === 0) {
    if (state.currentDepth !== 'none') {
      return {
        kind: 'exit', windowKey: window.key, exitMode: 'fade',
        fromDepth: state.currentDepth, fromAffordanceIds: state.activeAffordanceIds,
        basis: { reason: '该深度下无可用舞台转译，渐退', evidenceIds: [] },
      }
    }
    return {
      kind: 'withhold', windowKey: window.key, effect: 'keep',
      nextDepth: 'none', nextActiveIds: [],
      basis: { reason: '该深度下无可用舞台转译', evidenceIds: [] },
    }
  }

  const duration: 'instant' | 'segment' | 'until_next' =
    targetDepth === 'mirror' ? 'instant'
    : targetDepth === 'merge' ? 'segment'
    : 'until_next'

  return {
    kind: 'present',
    windowKey: window.key,
    depth: targetDepth as 'mirror' | 'merge' | 'enter',
    layers: used.map(a => ({ layer: a.layer, affordanceId: a.id, evidenceIds: a.derivedFrom })),
    duration,
    exitPlan: window.key === 'dream_enter' ? 'hold' : 'fade',
    basis: buildBasis(assessment, used),
  }
}

export function advanceState(state: DreamState, decision: DreamDecision): DreamState {
  const base = { ...state, previousDecision: decision }
  if (decision.kind === 'withhold') {
    return {
      ...base,
      currentDepth: decision.nextDepth,
      activeAffordanceIds: decision.nextActiveIds,
    }
  }
  if (decision.kind === 'exit') {
    return {
      ...base,
      currentDepth: 'none',
      activeAffordanceIds: [],
    }
  }
  const ids = decision.layers.map(l => l.affordanceId)
  return {
    ...base,
    currentDepth: decision.depth,
    activeAffordanceIds: ids,
    appearedAffordanceIds: Array.from(new Set([...state.appearedAffordanceIds, ...ids])),
    hasFormallyEntered: decision.depth === 'enter' ? true : state.hasFormallyEntered,
    interventionCount: state.interventionCount + 1,
  }
}
