import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { Chapter, Section, Segment } from '../types'
import type { BPersisted } from '../store'
import { logBEvent, recordBError } from '../store'
import { requestBResponse, type BResponseTable, type AgentStageEvent } from '../b-agent'
import { stopDreamCue, stopAmbient, setAmbientDream, setPerformanceMusic, playDreamCue, playPhrase, setWorldBias, playResolveBoard, type WorldBias } from '../sound'
import { deriveWorldState, worldToMusicMode } from '../world-state'

interface Props {
  chapter: Chapter
  state: BPersisted
  update: (fn: (s: BPersisted) => BPersisted) => void
  onFinish: () => void
}

// 第一轮测试演示链条：5-7 分钟可完成
// 深闺春情 → 镜前自我 → 不到园林 → 皂罗袍 → 自伤 → 入梦 → 梦醒 → 梦醒独白
const B_DEMO_CHAIN = ['10-01', '10-04', '10-06', '10-07', '10-10', '10-12', '10-13', '10-16', '10-17']

interface PinPop { sectionId: string; segIndex: number; text: string; x: number; y: number }

export default function ReaderB({ chapter, state, update, onFinish }: Props) {
  const [responseTable, setResponseTable] = useState<BResponseTable | null>(null)
  const [revealedCount, setRevealedCount] = useState<number>(() => {
    // 恢复进度：已揭示数 = 链条长度（读完）或 1（首次进入）
    return state.progress.finished ? B_DEMO_CHAIN.length : 1
  })
  const [pinPop, setPinPop] = useState<PinPop | null>(null)
  const [glossPop, setGlossPop] = useState<{ x: number; y: number; word: string; meaning: string } | null>(null)
  const [agentPending, setAgentPending] = useState(false)
  const [agentStages, setAgentStages] = useState<AgentStageEvent[]>([])
  const [showHint, setShowHint] = useState(state.hintExpanded)
  const [showFirstPinTip, setShowFirstPinTip] = useState(state.pins.length === 0)

  // 加载人工审核候选表
  useEffect(() => {
    fetch('data/b-response-candidates.json')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('候选表加载失败')))
      .then(setResponseTable)
      .catch(err => update(s => recordBError(s, String(err))))
  }, []) // eslint-disable-line

  const visibleSections = useMemo(
    () => B_DEMO_CHAIN.map(id => chapter.sections.find(s => s.id === id)).filter((s): s is Section => !!s),
    [chapter],
  )
  const revealedSections = visibleSections.slice(0, revealedCount)
  const allRevealed = revealedCount >= visibleSections.length

  // 当前阶段（用于声音调度）
  const lastSection = revealedSections[revealedSections.length - 1]
  const currentStage = lastSection?.stage || 'reality'
  useEffect(() => {
    if (currentStage === 'dream') {
      document.body.classList.add('stage-dream')
      setAmbientDream(true)
      playDreamCue(state.settings.sound)
    } else if (currentStage === 'wake') {
      document.body.classList.remove('stage-dream')
      stopDreamCue()
      setAmbientDream(false)
    }
    return () => { document.body.classList.remove('stage-dream') }
  }, [currentStage, state.settings.sound])

  useEffect(() => () => { stopDreamCue(); stopAmbient() }, [])

  // 前15秒钩子：进阅读页立即揭示第1段，并奏绕池游乐句（不用等读者点继续读）
  // 仅当首次空白进入时（未读完且没有恢复进度）触发一次
  useEffect(() => {
    let fired = false
    const t = window.setTimeout(() => {
      if (fired) return
      fired = true
      setRevealedCount(n => {
        const next = Math.max(1, n) // 保底 1
        if (next > 0) {
          // revealed=1 表示已经揭示了 index=0 的那一段，对应乐句下标 0
          const bias: WorldBias = (activePin ? deriveWorldState(activePin.text, currentStage).state : 'spring') as WorldBias
          const mode = worldToMusicMode(bias) || 'garden'
          playPhrase(0, mode)
        }
        return next
      })
    }, 180)
    return () => { window.clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // —— 世界状态：读者用针脚声明"变化开始"，世界随之在三层漂移 ——
  // 这是 Agent 工作的可见产物：AI 在排序候选时，色彩、墨色、声音也在回应读者
  const activePin = useMemo(() => state.pins.find(p => p.active), [state.pins])
  const worldResult = useMemo(
    () => deriveWorldState(activePin?.text ?? null, currentStage),
    [activePin?.text, currentStage],
  )
  const worldState = worldResult.state

  // body[data-world]：CSS 变量层据此漂移纸色 / 墨色 / 红线 / 今译
  useEffect(() => {
    document.body.dataset.world = worldState
    return () => { delete document.body.dataset.world }
  }, [worldState])

  // 落字脉冲：读者的读法字一变（设针脚 / 移针脚 / 入梦），当下就给一个极轻的"世界收到了"反馈，
  // 不让因果只等到最后的回应才兑现
  const [pulseKey, setPulseKey] = useState(0)
  useEffect(() => { setPulseKey(k => k + 1) }, [worldResult.traceGlyph])

  // 声音：读者偏向扭曲音乐调性（选"断井颓垣"则低沉，选"姹紫嫣红"则明亮）
  useEffect(() => {
    const mode = worldToMusicMode(worldState, currentStage)
    setPerformanceMusic(mode, 0.32, state.settings.sound, false)
  }, [worldState, currentStage, state.settings.sound])

  const pinsBySection = useMemo(() => {
    const map: Record<string, BPersisted['pins']> = {}
    for (const p of state.pins) (map[p.sectionId] ||= []).push(p)
    return map
  }, [state.pins])

  // 点击 segment → 设为开始（primary）/ 留下这句（secondary 弱化）
  const onSegmentClick = useCallback((section: Section, seg: Segment, segIndex: number, ev: React.MouseEvent) => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return // 有选区时不触发
    ev.stopPropagation()
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setPinPop({
      sectionId: section.id,
      segIndex,
      text: seg.text,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    })
  }, [])

  const setAsStart = useCallback((pop: PinPop) => {
    update(s => {
      const moved = s.pins.some(p => p.active)
      const next: BPersisted = {
        ...s,
        pins: [
          // 旧的 active 变淡，留作痕迹
          ...s.pins.map(p => ({ ...p, active: false })),
          { id: `pin-${Date.now().toString(36)}`, sectionId: pop.sectionId, text: pop.text, createdAt: Date.now(), active: true },
        ],
      }
      return logBEvent(next, moved ? 'move_pin' : 'set_pin', { sectionId: pop.sectionId, text: pop.text })
    })
    // 设针脚后，立刻重算世界扭曲：同一个读者点了"断井颓垣"，世界就按 ruin 唱
    const derived = deriveWorldState(pop.text, currentStage)
    setWorldBias(derived.state as WorldBias)
    setShowFirstPinTip(false)
    setPinPop(null)
  }, [update, currentStage])

  // 生词
  const openGloss = useCallback((word: string, meaning: string, ev: React.MouseEvent) => {
    ev.stopPropagation()
    const rect = (ev.target as HTMLElement).getBoundingClientRect()
    setGlossPop({ x: Math.min(rect.left, window.innerWidth - 240), y: rect.bottom + 6, word, meaning })
    update(s => logBEvent(s, 'open_gloss', { word }))
  }, [update])

  useEffect(() => {
    const close = () => { setGlossPop(null); setPinPop(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // 下一句
  const revealNext = useCallback(() => {
    setRevealedCount(n => {
      const next = Math.min(n + 1, visibleSections.length)
      // 读者每揭示一段，笛音跟奏对应乐句——不是背景循环，是读到哪，笛音跟到哪
      if (next > n) {
        const bias: WorldBias = worldResult.state
        const mode = worldToMusicMode(bias) || 'garden'
        playPhrase(n, mode) // n = 刚揭示的这个 block 的下标（0-based）
      }
      return next
    })
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }, [visibleSections.length, worldResult.state])

  // 触发 Agent 单次介入
  const requestAgent = useCallback(async () => {
    if (!responseTable || agentPending) return
    if (!activePin) {
      update(s => recordBError(s, '未设针脚即请求 Agent'))
      return
    }
    setAgentPending(true)
    setAgentStages([])
    try {
      const response = await requestBResponse(responseTable, state, (stage) => {
        setAgentStages(prev => [...prev, stage])
      })
      if (!response) {
        // 无可靠候选：只记住选择，不强行建立关系
        update(s => logBEvent({ ...s, agentResponse: null }, 'agent_select', { fallback: 'no_response' }))
      } else {
        update(s => logBEvent({ ...s, agentResponse: response }, 'agent_select', {
          responseId: response.responseId,
          source: response.source,
          readingPath: response.readingPath,
        }))
        // Agent 回应到来：落板音对应当前读法字（春/残/颜/梦/惊）
        const derived = deriveWorldState(activePin.text, currentStage)
        playResolveBoard(derived.traceGlyph)
      }
    } catch (err) {
      update(s => recordBError(s, 'Agent 请求失败：' + String(err)))
    } finally {
      setAgentPending(false)
    }
  }, [responseTable, agentPending, activePin, state, update, currentStage])

  const expandHint = useCallback(() => {
    setShowHint(true)
    update(s => logBEvent({ ...s, hintExpanded: true }, 'expand_hint'))
  }, [update])

  const agent = state.agentResponse

  let firstWakeSeen = false

  return (
    <div className="b-reader">
      <header className="b-reader-head">
        <span className="b-title-mark">游园</span>
        <span className="b-reader-title">第十出　惊梦</span>
      </header>

      <div className="b-core-question" role="note">
        读到哪里时，你开始觉得杜丽娘已经和游园前不一样了？
        <span className="b-core-help">你可以先选择一句，读到后面也可以改变判断。</span>
      </div>

      {showFirstPinTip && (
        <div className="b-pin-tip" role="note">
          <span>
            <strong>← 点上面任意一句原文</strong>，把它设为你认为"变化开始"的地方。<br />
            不用急着答对，先选一句，世界就会按它的样子变。
          </span>
          <button
            className="b-pin-tip-close"
            type="button"
            aria-label="关闭提示"
            onClick={(e) => { e.stopPropagation(); setShowFirstPinTip(false) }}
          >
            ×
          </button>
        </div>
      )}

      <div className="b-textcol">
        {revealedSections.map((section, idx) => {
          const isFirstWake = section.stage === 'wake' && !firstWakeSeen
          if (section.stage === 'wake') firstWakeSeen = true
          const sectionPins = pinsBySection[section.id] || []
          const isFirstAndHinting = idx === 0 && showFirstPinTip
          return (
            <section
              key={section.id}
              className={`b-section b-stage-${section.stage} ${isFirstWake ? 'b-wake-first' : ''} ${isFirstAndHinting ? 'b-section--hint-pulse' : ''}`}
              aria-label={section.tune ? `曲牌：${section.tune}` : '原文'}
            >
              <div className="b-section-meta">
                <span className="b-meta-tag">演示节选 · 原文</span>
                {section.tune && <span className="b-tune">【{section.tune}】</span>}
              </div>

              {/* 针脚：active 实心；旧针脚淡痕 */}
              {sectionPins.length > 0 && (
                <div className="b-pins" aria-hidden="true">
                  {sectionPins.map((p, i) => (
                    <span key={p.id} className={`b-pin ${p.active ? 'active' : 'past'}`} style={{ left: 0, top: `calc(0.4em + ${i * 6}px)` }} />
                  ))}
                </div>
              )}

              {section.segments.map((seg, si) => {
                const isPinned = sectionPins.some(p => p.text === seg.text && p.active)
                return (
                  <p
                    key={si}
                    className={`b-seg ${seg.inner ? 'inner' : ''} ${seg.aside ? 'aside' : ''} ${isPinned ? 'pinned' : ''}`}
                    onClick={ev => onSegmentClick(section, seg, si, ev)}
                  >
                    {seg.speaker && <span className="b-speaker">{seg.speaker}：</span>}
                    <span className="b-seg-text">{decorateGloss(seg.text, section, openGloss)}</span>
                    {seg.stageHint && <span className="b-stage-hint">（{seg.stageHint}）</span>}
                  </p>
                )
              })}

              {state.settings.vernacular && section.vernacular && (
                <p className="b-vernacular">
                  <span className="b-vernacular-tag">今译 · 非原文</span>
                  {section.vernacular}
                </p>
              )}
            </section>
          )
        })}

        {/* 阅读进度 */}
        <div className="b-progress">
          <span>{revealedCount} / {visibleSections.length}</span>
        </div>

        {/* 设针脚后，AI 入口立刻出现——不用读到结尾才看到 Agent 在参与核心体验 */}
        {!agent && activePin && (
          <div className="b-agent-entry">
            <p className="b-agent-prompt">
              你把变化的开始放在：「{activePin.text.length > 16 ? activePin.text.slice(0, 16) + '…' : activePin.text}」
            </p>
            <button
              className="text-entry"
              onClick={requestAgent}
              disabled={agentPending}
            >
              {agentPending
                ? 'AI 正在找一句回应你的原文…'
                : allRevealed
                  ? '让 AI 找一句《寻梦》回应你'
                  : '让 AI 回应你的选择'}
            </button>
            {!allRevealed && <p className="b-agent-help">你也可以先继续往下读。</p>}

            {/* Agent 思考过程：让读者看到 AI 在"接收目标→计划→用工具→检查→修正→完成" */}
            {agentStages.length > 0 && (
              <div className="b-agent-trace" aria-label="AI 思考过程" role="status">
                <span className="b-agent-trace-tag">AI 思考过程</span>
                <ol className="b-agent-trace-list">
                  {agentStages.map((s, i) => {
                    const isLast = i === agentStages.length - 1
                    return (
                      <li key={i} className={`b-agent-trace-item ${isLast && agentPending ? 'running' : ''} ${isLast ? 'tail' : ''}`}>
                        <span className="b-at-index">{String(i + 1).padStart(2, '0')}</span>
                        <span className="b-at-label">{s.label}</span>
                        <span className="b-at-detail">{s.detail}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            )}
          </div>
        )}

        {/* 继续读：未读完时持续可见，与 AI 入口并列 */}
        {!allRevealed && (
          <div className="b-next-entry">
            <button className="text-entry" onClick={revealNext}>继续读下一句</button>
          </div>
        )}

        {/* Agent 回应：先原文，再问关系，最后可选提示 */}
        {agent && (
          <div className="b-agent-response" role="region" aria-label="原文回应">
            <span className="b-agent-seal" aria-hidden="true">寻</span>
            <div className="b-agent-source">
              <span className="b-agent-tag">原文 · {agent.candidateSnapshot.where}</span>
              <p className="b-agent-text">{agent.candidateSnapshot.sourceText}</p>
            </div>

            <p className="b-agent-relation-question">
              这句话和你刚才选择的那一句，有什么关系？
            </p>
            <div className="b-agent-relation-actions">
              <button className="text-entry-small" onClick={expandHint} disabled={showHint}>
                {showHint ? '收起' : '换一个角度读一读'}
              </button>
            </div>

            {showHint && (
              <div className="b-agent-hint">
                <span className="b-hint-tag">阅读提示</span>
                <p>{agent.candidateSnapshot.hint}</p>
              </div>
            )}

            <div className="b-finish-entry">
              {allRevealed ? (
                <button
                  className="text-entry"
                  onClick={() => {
                    update(s => ({ ...s, progress: { ...s.progress, finished: true } }))
                    onFinish()
                  }}
                >
                  读完，重新想一遍
                </button>
              ) : (
                <button className="text-entry" onClick={revealNext}>
                  继续往下读
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 设为开始 / 留下这句（次要） */}
      {pinPop && (
        <div
          className="b-pin-pop"
          style={{ left: pinPop.x, top: pinPop.y, transform: 'translateX(-50%)' }}
          onClick={e => e.stopPropagation()}
        >
          <button className="b-pin-primary" onClick={() => setAsStart(pinPop)} autoFocus>
            {activePin ? '把开始改到这里' : '设为开始'}
          </button>
        </div>
      )}

      {/* 生词 */}
      {glossPop && (
        <div className="b-gloss-pop" style={{ left: glossPop.x, top: glossPop.y }} role="tooltip" onClick={e => e.stopPropagation()}>
          <span className="b-gloss-title">{glossPop.word}</span>
          {glossPop.meaning}
        </div>
      )}

      {/* 读法痕迹：读者这一路的视觉签名；设针脚当下落字脉冲，回应到来时高亮兑现因果 */}
      <div className="b-trace" aria-hidden="true" data-glow={agent ? 'on' : 'off'}>
        <span key={pulseKey} className="b-trace-glyph" data-glow={agent ? 'on' : 'off'}>{worldResult.traceGlyph}</span>
        <span className="b-trace-label">
          {agent ? 'AI 找到了回应' : activePin ? 'AI 在听' : '你的读法'}
        </span>
      </div>
    </div>
  )
}

/* 给生词加点的简单装饰 */
function decorateGloss(
  text: string,
  section: Section,
  onGloss: (word: string, meaning: string, ev: React.MouseEvent) => void,
): React.ReactNode {
  if (!section.glosses.length) return text
  type R = { s: number; e: number; word: string; meaning: string }
  const ranges: R[] = []
  for (const g of section.glosses) {
    const idx = text.indexOf(g.word)
    if (idx >= 0) ranges.push({ s: idx, e: idx + g.word.length, word: g.word, meaning: g.meaning })
  }
  if (!ranges.length) return text
  const points = new Set<number>([0, text.length])
  ranges.forEach(r => { points.add(r.s); points.add(r.e) })
  const sorted = [...points].sort((a, b) => a - b)
  const out: React.ReactNode[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1]
    if (a === b) continue
    const chunk = text.slice(a, b)
    const g = ranges.find(r => r.s <= a && r.e >= b)
    if (g) {
      out.push(
        <span key={a} className="b-gloss-word" onClick={ev => onGloss(g.word, g.meaning, ev)}>
          {chunk}
        </span>,
      )
    } else {
      out.push(<React.Fragment key={a}>{chunk}</React.Fragment>)
    }
  }
  return out
}
