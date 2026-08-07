/**
 * 司梦人低语 Agent —— 让 AI 真正在场
 *
 * 职责：
 * - 在读者推进/选择/停顿/回看时，调用 /api/dream-whisper 生成一句低语
 * - 维持低语记忆（最近3句），避免重复
 * - 不强迫读者回应，低语只是让读者感到"被看见"
 *
 * 这不是问答，是戏台上一个在场的意识。
 */

export interface WhisperContext {
  phaseId: string
  phaseLabel: string
  beatText: string
  readerAction: 'advance' | 'choose' | 'pause' | 'revisit'
  choiceLabel?: string
  pauseMs?: number
  memoryRawText?: string
  dreamDecisionDesc?: string
}

export interface Whisper {
  text: string
  tone: 'observe' | 'echo' | 'hold' | 'shift'
  source: 'deepseek' | 'local'
  timestamp: number
}

export class WhisperAgent {
  private history: Whisper[] = []
  private lastBeatIndex = -1
  private lastActionTime = Date.now()
  private loading = false

  isLoading() { return this.loading }

  getHistory(): Whisper[] { return [...this.history] }

  getLast(): Whisper | null {
    return this.history.length ? this.history[this.history.length - 1] : null
  }

  /** 距离上一句低语是否足够久（避免刷屏） */
  private shouldWhisper(now: number, action: string): boolean {
    if (this.history.length === 0) return true
    const last = this.history[this.history.length - 1]
    const gap = now - last.timestamp
    // 选择动作立即响应；推进/停顿至少间隔 4 秒
    if (action === 'choose') return gap > 1500
    if (action === 'pause') return gap > 2000
    return gap > 4000
  }

  /** 调用低语；不满足间隔则跳过 */
  async whisper(ctx: WhisperContext): Promise<Whisper | null> {
    const now = Date.now()
    if (!this.shouldWhisper(now, ctx.readerAction)) return null
    if (this.loading) return null

    this.loading = true
    this.lastActionTime = now

    try {
      const res = await fetch('/api/dream-whisper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phaseId: ctx.phaseId,
          phaseLabel: ctx.phaseLabel,
          beatText: ctx.beatText,
          readerAction: ctx.readerAction,
          choiceLabel: ctx.choiceLabel || '',
          pauseMs: ctx.pauseMs || 0,
          memoryRawText: ctx.memoryRawText || '',
          dreamDecisionDesc: ctx.dreamDecisionDesc || '',
          recentWhispers: this.history.slice(-3).map(w => w.text),
        }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const text = String(data.whisper || '').slice(0, 60)
      if (!text) return null
      const tone = (['observe', 'echo', 'hold', 'shift'].includes(data.tone) ? data.tone : 'observe') as Whisper['tone']
      const source = data.source === 'deepseek' ? 'deepseek' : 'local'
      const w: Whisper = { text, tone, source, timestamp: now }
      this.history.push(w)
      if (this.history.length > 8) this.history.shift()
      return w
    } catch {
      return null
    } finally {
      this.loading = false
    }
  }

  reset() {
    this.history = []
    this.lastBeatIndex = -1
    this.lastActionTime = Date.now()
  }
}

let agent: WhisperAgent | null = null
export function getWhisperAgent(): WhisperAgent {
  if (!agent) agent = new WhisperAgent()
  return agent
}
export function resetWhisperAgent(): void {
  agent = null
}
