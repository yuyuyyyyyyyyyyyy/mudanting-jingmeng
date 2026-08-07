import type { Underline, Annotation, Settings, Progress, StartMark, AttentionState } from './types'

const KEY = 'mudanting.jingmeng.v1'
// B 版独立存储键：A 版数据保留可比较性，互不污染
const KEY_B = 'mudanting.jingmeng.b.v1'

interface Persisted {
  underlines: Underline[]
  starts: StartMark[]
  annotations: Annotation[]
  settings: Settings
  progress: Progress
  dismissedQuestions: string[] // 旧版字段，保留兼容，不再使用
  shownEchoHints: string[]   // echoId 已提示过的（避免重复打扰）
  attention?: AttentionState // AI 演出调度的隐形注意力状态（可选，兼容旧数据）
}

const defaults: Persisted = {
  underlines: [],
  starts: [],
  annotations: [],
  settings: { sound: true, motion: true, demoMode: true, vernacular: true },
  progress: { maxRevealed: -1, finished: false },
  dismissedQuestions: [],
  shownEchoHints: [],
}

export function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(defaults)
    const parsed = JSON.parse(raw)
    return { ...structuredClone(defaults), ...parsed }
  } catch {
    return structuredClone(defaults)
  }
}

export function save(state: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // 隐私模式等场景下静默失败，阅读体验不受影响
  }
}

export function clearAll() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}

// ============================================================
// B 版（第一轮测试版）状态：与 A 版完全隔离
// ============================================================

/** 针脚历史：每次"设为开始"都记录一条，旧条 active=false 留下淡痕 */
export interface BPinRecord {
  id: string
  sectionId: string
  text: string
  createdAt: number
  active: boolean
}

/** Agent 一次核心介入的结构化输出 */
export interface BAgentResponse {
  responseId: string         // 人工审核候选 ID
  readingPath: string        // 当前理解类别
  relation: string           // 支持／深化／转折／反证
  reason: string             // 选择依据（简短）
  source: 'deepseek' | 'local'
  candidateSnapshot: {       // 候选快照，用于离线展示与导出
    sourceText: string
    where: string
    hint: string
  }
  requestedAt: number
}

export interface BTestEvent {
  t: number
  type: string   // start | submit_initial | open_vernacular | open_gloss | set_pin | move_pin | agent_select | expand_hint | final_keep | final_move | final_keep_both | submit_final | error
  detail?: unknown
}

export interface BPersisted {
  version: 'B-test-v1'
  sessionIndex: number       // 从 1 开始；用于生成 S01、S02…
  sessionStartedAt: number | null
  initialUnderstanding: string   // 体验前自由输入，原样保存，不润色
  pins: BPinRecord[]             // 针脚历史（含淡痕）
  agentResponse: BAgentResponse | null
  hintExpanded: boolean          // 是否主动点开"看看为什么"
  finalChoice: 'keep' | 'move' | 'keep_both' | null
  finalUnderstanding: string     // 体验后自由输入
  events: BTestEvent[]           // 本地事件日志
  settings: { sound: boolean; motion: boolean; vernacular: boolean }
  progress: { finished: boolean }
  lastError: string | null
}

const bDefaults: BPersisted = {
  version: 'B-test-v1',
  sessionIndex: 0,
  sessionStartedAt: null,
  initialUnderstanding: '',
  pins: [],
  agentResponse: null,
  hintExpanded: false,
  finalChoice: null,
  finalUnderstanding: '',
  events: [],
  settings: { sound: true, motion: true, vernacular: false },
  progress: { finished: false },
  lastError: null,
}

export function loadB(): BPersisted {
  try {
    const raw = localStorage.getItem(KEY_B)
    if (!raw) return structuredClone(bDefaults)
    const parsed = JSON.parse(raw)
    return { ...structuredClone(bDefaults), ...parsed }
  } catch {
    return structuredClone(bDefaults)
  }
}

export function saveB(state: BPersisted) {
  try {
    localStorage.setItem(KEY_B, JSON.stringify(state))
  } catch { /* ignore */ }
}

/** 为下一位体验者清空：保留 sessionIndex 计数，重置其余字段 */
export function clearBForNext(): BPersisted {
  const prev = loadB()
  const next: BPersisted = {
    ...structuredClone(bDefaults),
    sessionIndex: prev.sessionIndex, // 由 startNewBSession 自增
    settings: prev.settings,         // 保留声音/动效/今译偏好
  }
  try {
    localStorage.setItem(KEY_B, JSON.stringify(next))
  } catch { /* ignore */ }
  return next
}

/** 开始一个新的匿名体验会话：sessionIndex + 1，记录开始时间，返回 S## 编号 */
export function startNewBSession(): BPersisted {
  const prev = loadB()
  const next: BPersisted = {
    ...structuredClone(bDefaults),
    sessionIndex: prev.sessionIndex + 1,
    sessionStartedAt: Date.now(),
    settings: prev.settings,
    events: [{ t: Date.now(), type: 'start', detail: { session: `S${String(prev.sessionIndex + 1).padStart(2, '0')}` } }],
  }
  try {
    localStorage.setItem(KEY_B, JSON.stringify(next))
  } catch { /* ignore */ }
  return next
}

export function bSessionLabel(state: BPersisted): string {
  return `S${String(Math.max(1, state.sessionIndex)).padStart(2, '0')}`
}

/** 记录一条事件 */
export function logBEvent(state: BPersisted, type: BTestEvent['type'], detail?: unknown): BPersisted {
  return { ...state, events: [...state.events, { t: Date.now(), type, detail }] }
}

/** 记录技术错误 */
export function recordBError(state: BPersisted, message: string): BPersisted {
  return { ...state, lastError: message, events: [...state.events, { t: Date.now(), type: 'error', detail: message }] }
}

/** 导出匿名测试记录 JSON（不含姓名、联系方式） */
export function exportBRecord(state: BPersisted): string {
  const record = {
    testVersion: state.version,
    sessionLabel: bSessionLabel(state),
    sessionIndex: state.sessionIndex,
    startedAt: state.sessionStartedAt,
    finishedAt: state.progress.finished ? ( [...state.events].reverse().find((e: BTestEvent) => e.type === 'submit_final')?.t ?? null) : null,
    initialUnderstanding: state.initialUnderstanding,
    pinsHistory: state.pins.map(p => ({ sectionId: p.sectionId, text: p.text, createdAt: p.createdAt, active: p.active })),
    firstPin: state.pins[0] ? { sectionId: state.pins[0].sectionId, text: state.pins[0].text } : null,
    agentResponse: state.agentResponse ? {
      responseId: state.agentResponse.responseId,
      readingPath: state.agentResponse.readingPath,
      relation: state.agentResponse.relation,
      source: state.agentResponse.source,
    } : null,
    hintExpanded: state.hintExpanded,
    finalChoice: state.finalChoice,
    finalUnderstanding: state.finalUnderstanding,
    eventCount: state.events.length,
    events: state.events,
    lastError: state.lastError,
    // 明确不导出：姓名、联系方式、IP、浏览器指纹等
    note: '本记录不含姓名与联系方式；自由回答仅在本机保存，未上传任何服务器。',
  }
  return JSON.stringify(record, null, 2)
}

export type { Persisted }
