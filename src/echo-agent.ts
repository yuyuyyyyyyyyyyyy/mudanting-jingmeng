/**
 * 回声 Agent —— 戏台记得读者的选择
 *
 * 职责：
 * - 在相位转换、选择积累到阈值、结尾时，调用 /api/echo 让一句旧原文回响
 * - 回声不是 AI 生成的话，是汤显祖的原文，因读者的选择才被选中
 * - 维持回声历史，避免同一句短期内重复
 *
 * 这是核心交互：读者通过选择，决定哪句原文回响。
 */

export interface EchoCandidate {
  id: string
  sourceText: string
  targetText: string
  relation: string
  explanation: string
  earliestAt: string
}

export interface EchoContext {
  phaseId: string
  phaseLabel: string
  beatText: string
  currentSectionId: string
  dominantMotifs: string[]
  recentChoices: { optionId: string; motifs: string[] }[]
  echoes: EchoCandidate[]
}

export interface EchoResult {
  echoId: string
  sourceText: string
  targetText: string
  relation: string
  reason: string
  confidence: number
  source: 'deepseek' | 'local'
  timestamp: number
}

export class EchoAgent {
  private history: EchoResult[] = []
  private lastEchoTime = 0
  private loading = false

  isLoading() { return this.loading }

  getHistory(): EchoResult[] { return [...this.history] }

  getLast(): EchoResult | null {
    return this.history.length ? this.history[this.history.length - 1] : null
  }

  private sectionIndexMap: Record<string, number> = {}

  setSectionOrder(sectionIds: string[]) {
    this.sectionIndexMap = {}
    sectionIds.forEach((id, i) => { this.sectionIndexMap[id] = i })
  }

  private sectionGte(a: string, b: string): boolean {
    const ai = this.sectionIndexMap[a] ?? -1
    const bi = this.sectionIndexMap[b] ?? -1
    if (ai < 0 || bi < 0) return false
    return ai >= bi
  }

  private filterByEarliestAt(ctx: EchoContext): EchoCandidate[] {
    if (!ctx.currentSectionId) return ctx.echoes
    return ctx.echoes.filter(e => this.sectionGte(ctx.currentSectionId, e.earliestAt))
  }

  private shouldEcho(now: number): boolean {
    if (this.history.length === 0) return true
    return now - this.lastEchoTime > 12000
  }

  private localSelect(ctx: EchoContext): EchoResult | null {
    const available = this.filterByEarliestAt(ctx)
    if (!available.length) return null
    const dom = new Set(ctx.dominantMotifs)
    let best: { echo: EchoCandidate; score: number } | null = null
    for (const e of available) {
      const text = (e.sourceText + e.targetText + e.relation + e.explanation).toLowerCase()
      let score = 0.5
      if (dom.has('spring') && /春|花|莺|色|景/.test(text)) score += 1
      if (dom.has('ruin') && /断|颓|旧|废|衰/.test(text)) score += 1
      if (dom.has('self') && /妾|身|颜色|命|怜|自/.test(text)) score += 1
      if (dom.has('sound') && /莺|声|歌|唱|啼/.test(text)) score += 1
      if (dom.has('time') && /年|岁|流|逝|旧/.test(text)) score += 1
      if (dom.has('dream') && /梦|觉|醒|幻/.test(text)) score += 1
      if (this.history.some(h => h.echoId === e.id)) score *= 0.3
      if (!best || score > best.score) best = { echo: e, score }
    }
    if (!best) return null
    const e = best.echo
    return {
      echoId: e.id, sourceText: e.sourceText, targetText: e.targetText,
      relation: e.relation, reason: '戏台记得你一路的留意。', confidence: 0.5,
      source: 'local', timestamp: Date.now(),
    }
  }

  async echo(ctx: EchoContext): Promise<EchoResult | null> {
    const now = Date.now()
    if (!this.shouldEcho(now)) return null
    if (this.loading) return null
    const available = this.filterByEarliestAt(ctx)
    if (!available.length) return null

    this.loading = true
    try {
      const res = await fetch('/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phaseId: ctx.phaseId,
          phaseLabel: ctx.phaseLabel,
          beatText: ctx.beatText,
          currentSectionId: ctx.currentSectionId,
          dominantMotifs: ctx.dominantMotifs,
          recentChoices: ctx.recentChoices,
          echoes: available,
        }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const found = available.find(e => e.id === String(data.echoId || ''))
      if (!found) return null
      const result: EchoResult = {
        echoId: found.id, sourceText: found.sourceText, targetText: found.targetText,
        relation: found.relation,
        reason: String(data.reason || '').slice(0, 60),
        confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
        source: data.source === 'deepseek' ? 'deepseek' : 'local',
        timestamp: now,
      }
      this.history.push(result)
      if (this.history.length > 6) this.history.shift()
      this.lastEchoTime = now
      return result
    } catch {
      const local = this.localSelect({ ...ctx, echoes: available })
      if (local) {
        this.history.push(local)
        if (this.history.length > 6) this.history.shift()
        this.lastEchoTime = now
      }
      return local
    } finally {
      this.loading = false
    }
  }

  reset() { this.history = []; this.lastEchoTime = 0; this.sectionIndexMap = {} }
}

let agent: EchoAgent | null = null
export function getEchoAgent(): EchoAgent {
  if (!agent) agent = new EchoAgent()
  return agent
}
export function resetEchoAgent(): void { agent = null }
