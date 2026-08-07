/**
 * 司梦编排器 —— 把司梦法则接进真实演出流程
 *
 * 职责：
 * - 在演出开始前采集用户记忆
 * - 在六窗口调用 AI（证据 + 兼容性）和代码（守法）
 * - 把决定输出给 Performance 组件，叠加到舞台
 *
 * Performance 组件读这个模块的 dreamRef，不直接调 AI。
 */
import { deriveMemoryEvidence, assessCompatibility } from './dream-agent'
import {
  type DreamMemory, type DreamState, type DreamDecision, type DramaWindow,
  type WindowKey, type UserResponse, type LayerUse,
  WINDOWS, initialDreamState, applyDreamLaw, applyResponseToState, advanceState,
  validateMemoryEvidence, validateAssessment,
} from './dream-law'

export interface DreamLogEntry {
  windowKey: WindowKey
  windowLabel: string
  decision: DreamDecision
  memoryRawText: string
  timestamp: number
}

export interface DreamOrchestration {
  state: DreamState
  memory: DreamMemory | null
  currentDecision: DreamDecision | null
  log: DreamLogEntry[]
}

export class DreamOrchestrator {
  private memory: DreamMemory | null = null
  private state: DreamState = initialDreamState()
  private log: DreamLogEntry[] = []
  private currentDecision: DreamDecision | null = null
  private loadingMemory = false

  /** 是否已采集记忆 */
  hasMemory(): boolean { return this.memory !== null }

  /** 是否正在加载记忆 */
  isLoadingMemory(): boolean { return this.loadingMemory }

  /** 获取当前记忆原话（供 UI 显示） */
  getMemoryRawText(): string { return this.memory?.rawText ?? '' }

  /** 获取当前决定 */
  getCurrentDecision(): DreamDecision | null { return this.currentDecision }

  /** 获取完整快照 */
  snapshot(): DreamOrchestration {
    return {
      state: { ...this.state },
      memory: this.memory,
      currentDecision: this.currentDecision,
      log: [...this.log],
    }
  }

  /** 步骤1：采集用户记忆，调 AI 提取证据 */
  async collectMemory(rawText: string): Promise<boolean> {
    this.loadingMemory = true
    try {
      const mem = await deriveMemoryEvidence(rawText)
      if (!mem || !validateMemoryEvidence(mem)) {
        // 本地兜底：构造最小证据，避免演出中断
        this.memory = this.localFallbackMemory(rawText)
        this.loadingMemory = false
        return true
      }
      this.memory = mem
      this.loadingMemory = false
      return true
    } catch {
      this.memory = this.localFallbackMemory(rawText)
      this.loadingMemory = false
      return true
    }
  }

  /** 步骤2-5：在某窗口执行司梦判断 */
  async decideAtWindow(
    windowKey: WindowKey,
    response: UserResponse = { kind: 'none' },
  ): Promise<DreamDecision | null> {
    if (!this.memory) return null
    const window = WINDOWS[windowKey]

    // 更新状态（许可/拒绝/沉默）
    this.state = applyResponseToState(this.state, response)

    // 惊醒窗口无需 AI 兼容性判断，直接走法则
    let assessment
    if (window.mode.kind === 'exit_only') {
      assessment = { perAffordance: [], originalConflict: 'low', characterIntrusionRisk: 'low', reasons: [] }
    } else {
      assessment = await assessCompatibility(this.memory, window)
      if (!assessment || !validateAssessment(assessment, this.memory)) {
        // 兜底：全 supported 但低深度，让法则来守
        assessment = this.localFallbackAssessment(this.memory)
      }
    }

    const decision = applyDreamLaw(this.memory, window, this.state, response, assessment)
    this.state = advanceState(this.state, decision)
    this.currentDecision = decision

    this.log.push({
      windowKey,
      windowLabel: window.label,
      decision,
      memoryRawText: this.memory.rawText,
      timestamp: Date.now(),
    })
    return decision
  }

  /** 获取用于显示的决定描述 */
  describeDecision(d: DreamDecision): string {
    if (d.kind === 'withhold') {
      const effectMap = { keep: '维持', clear: '退场' }
      return `${effectMap[d.effect]} · ${d.basis.reason}`
    }
    if (d.kind === 'exit') {
      return d.residue
        ? `渐退 · 留一痕`
        : `退出 · ${d.basis.reason}`
    }
    const depthMap = { mirror: '映照', merge: '叠合', enter: '正式入梦' }
    const layers = d.layers.map(l => layerLabel(l)).join('、')
    return `${depthMap[d.depth]} · ${layers}`
  }

  /** 本地兜底：从原话粗暴提取，保证演出不中断 */
  private localFallbackMemory(rawText: string): DreamMemory {
    return {
      rawText,
      evidence: [{ id: 'e1', text: rawText.slice(0, Math.min(10, rawText.length)), start: 0, end: Math.min(10, rawText.length), kind: 'object' }],
      affordances: [
        { id: 'a1', value: '极轻的声音回响', layer: 'sound', depth: 'mirror', derivedFrom: ['e1'], transformation: '兜底：原话→声音(一瞬)' },
      ],
      forbiddenExamples: [],
    }
  }

  /** 本地兜底评估：全 supported，让法则来决定 */
  private localFallbackAssessment(memory: DreamMemory) {
    return {
      perAffordance: memory.affordances.map(a => ({
        affordanceId: a.id,
        grounding: 'supported' as const,
        sensoryBridge: 'weak' as const,
        spatialBridge: 'none' as const,
        actionBridge: 'none' as const,
        allowedLayers: [a.layer],
        evidenceIds: a.derivedFrom,
        reason: '本地兜底评估',
      })),
      originalConflict: 'low' as const,
      characterIntrusionRisk: 'low' as const,
      reasons: [],
    }
  }
}

function layerLabel(l: LayerUse): string {
  const m = { sound: '声音', space: '空间', scene: '景物', action: '动作', narration: '旁白' }
  return m[l.layer] || l.layer
}

/** 单例 */
let orchestrator: DreamOrchestrator | null = null
export function getDreamOrchestrator(): DreamOrchestrator {
  if (!orchestrator) orchestrator = new DreamOrchestrator()
  return orchestrator
}
export function resetDreamOrchestrator(): void {
  orchestrator = null
}
