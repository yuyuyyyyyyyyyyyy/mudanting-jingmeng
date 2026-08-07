import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chapter, Section, Underline } from '../types'
import type { Persisted } from '../store'
import { interpretUnderline, findReviewedEchoes, sectionText } from '../engine'
import { playDreamCue, stopDreamCue, stopAmbient, setAmbientDream, setPerformanceMusic } from '../sound'
import { getPerformanceCue, isPhaseEntrance } from '../performance'
import Juxtapose from './Juxtapose'
import type { JuxtaposeData } from './Juxtapose'

interface Props {
  chapter: Chapter
  state: Persisted
  update: (fn: (s: Persisted) => Persisted) => void
  onFinish: () => void
  onOpenCatalog: () => void
  onOpenAbout: () => void
}

interface SelPop {
  x: number
  y: number
  sectionId: string
  start: number
  end: number
  text: string
}

interface GlossPop { x: number; y: number; word: string; meaning: string }
interface CancelPop { x: number; y: number; underline: Underline }

/* ---------- 文本装饰：下划线 + 生词 ---------- */

function decorateSegment(
  text: string,
  segStart: number,
  section: Section,
  underlines: Underline[],
  dreamFaded: boolean,
  onUline: (u: Underline, ev: React.MouseEvent) => void,
  onGloss: (word: string, meaning: string, ev: React.MouseEvent) => void,
): React.ReactNode {
  type R =
    | { s: number; e: number; kind: 'u'; u: Underline }
    | { s: number; e: number; kind: 'g'; word: string; meaning: string }
  const ranges: R[] = []
  const segEnd = segStart + text.length
  for (const u of underlines) {
    const s = Math.max(u.startOffset, segStart) - segStart
    const e = Math.min(u.endOffset, segEnd) - segStart
    if (s < e && s >= 0) ranges.push({ s, e, kind: 'u', u })
  }
  for (const g of section.glosses) {
    const idx = text.indexOf(g.word)
    if (idx >= 0) ranges.push({ s: idx, e: idx + g.word.length, kind: 'g', word: g.word, meaning: g.meaning })
  }
  if (!ranges.length) return text
  const points = new Set<number>([0, text.length])
  ranges.forEach(r => { points.add(r.s); points.add(r.e) })
  const sorted = [...points].sort((a, b) => a - b)
  const out: React.ReactNode[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1]
    if (a === b) continue
    const chunk: React.ReactNode = text.slice(a, b)
    const u = ranges.find(r => r.kind === 'u' && r.s <= a && r.e >= b)
    const g = ranges.find(r => r.kind === 'g' && r.s <= a && r.e >= b)
    let node: React.ReactNode = chunk
    if (u && u.kind === 'u') {
      node = (
        <span
          className={`uline ${dreamFaded && section.stage === 'dream' ? 'rouge-trace' : ''}`}
          onClick={ev => onUline((u as any).u, ev)}
        >
          {node}
        </span>
      )
    }
    if (g && g.kind === 'g') {
      node = (
        <span className="gloss-word" onClick={ev => onGloss((g as any).word, (g as any).meaning, ev)}>
          {node}
        </span>
      )
    }
    out.push(<React.Fragment key={`${segStart}-${a}`}>{node}</React.Fragment>)
  }
  return out
}

/* ---------- 选区 → 段落内偏移 ---------- */

function locateOffset(sectionEl: HTMLElement, node: Node, offset: number): number | null {
  const segTexts = Array.from(sectionEl.querySelectorAll<HTMLElement>('.seg-text'))
  for (const st of segTexts) {
    if (!st.contains(node)) continue
    const base = Number(st.dataset.segstart || 0)
    if (node.nodeType === Node.TEXT_NODE) {
      const walker = document.createTreeWalker(st, NodeFilter.SHOW_TEXT)
      let acc = 0
      let cur = walker.nextNode()
      while (cur) {
        if (cur === node) return base + acc + offset
        acc += (cur.textContent || '').length
        cur = walker.nextNode()
      }
      return base + acc
    }
    // 元素节点：offset 为子节点序号
    let acc = 0
    for (let i = 0; i < offset && i < node.childNodes.length; i++) {
      acc += (node.childNodes[i].textContent || '').length
    }
    return base + acc
  }
  return null
}

/* ---------- 皂罗袍的特殊节奏 ---------- */

const ZL_PARTS: { text: string; cls?: string; delay: number }[] = [
  { text: '原来', delay: 200 },
  { text: '姹紫嫣红开遍', cls: 'zl-rouge', delay: 1000 },
  { text: '，似这般都付与', delay: 1700 },
  { text: '断井颓垣', cls: 'zl-cool', delay: 2400 },
  { text: '。', delay: 2700 },
]

function ZaoLuoPaoLine({ text, revealed }: { text: string; revealed: boolean }) {
  // 仅当文本与预设完全一致时启用节奏拆分（保护校对原文不被改错）
  const expected = ZL_PARTS.map(p => p.text).join('')
  if (text !== expected) return <>{text}</>
  return (
    <span className={`zl-line ${revealed ? 'zl-on' : ''}`}>
      {ZL_PARTS.map((p, i) => (
        <span key={i} className={`zl-part ${p.cls || ''}`} style={{ transitionDelay: `${p.delay}ms` }}>
          {p.text}
        </span>
      ))}
    </span>
  )
}

/* ---------- 主组件 ---------- */

export default function Reader({ chapter, state, update, onFinish, onOpenCatalog, onOpenAbout }: Props) {
  const visible = useMemo(
    () =>
      state.settings.demoMode
        ? chapter.sections.filter(s => chapter.demoSectionIds.includes(s.id))
        : chapter.sections,
    [chapter, state.settings.demoMode],
  )
  const chapterOrder = useMemo(() => chapter.sections.map(s => s.id), [chapter])

  const [maxRevealed, setMaxRevealed] = useState<number>(state.progress.maxRevealed)
  const [skipAll, setSkipAll] = useState(false)
  const [sel, setSel] = useState<SelPop | null>(null)
  const [gloss, setGloss] = useState<GlossPop | null>(null)
  const [cancelPop, setCancelPop] = useState<CancelPop | null>(null)
  const [bookNote, setBookNote] = useState<{ sectionId: string; text: string } | null>(null)
  const [hints, setHints] = useState<Record<string, JuxtaposeData[]>>({})
  const [juxtapose, setJuxtapose] = useState<JuxtaposeData | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(state.progress.maxRevealed)
  const maxRevealedRef = useRef(maxRevealed)
  maxRevealedRef.current = maxRevealed
  const hintsFnRef = useRef<(idx: number) => void>(() => {})

  const motion = state.settings.motion
  const clampedIdx = Math.min(maxRevealed, visible.length - 1)
  const activeSectionId = clampedIdx >= 0 && visible[clampedIdx] ? visible[clampedIdx].id : visible[0]?.id || '10-01'
  const performanceCue = useMemo(
    () => getPerformanceCue(activeSectionId, chapterOrder), [activeSectionId, chapterOrder])
  const currentStage: string = clampedIdx >= 0 && visible[clampedIdx] ? visible[clampedIdx].stage : 'reality'
  const dreamFaded = currentStage === 'wake'
  const prevStageRef = useRef('reality')

  /* —— 段落纯文本偏移表 —— */
  const segStarts = useMemo(() => {
    const map: Record<string, number[]> = {}
    for (const s of chapter.sections) {
      const arr: number[] = []
      let acc = 0
      for (const seg of s.segments) {
        arr.push(acc)
        acc += seg.text.length
      }
      map[s.id] = arr
    }
    return map
  }, [chapter])

  const underlinesBySection = useMemo(() => {
    const map: Record<string, Underline[]> = {}
    for (const u of state.underlines) {
      ;(map[u.sectionId] ||= []).push(u)
    }
    return map
  }, [state.underlines])

  const activeStart = useMemo(() => state.starts.find(s => s.active), [state.starts])

  /** 红线针脚：每个段落下是否有「开始」（含沉入痕迹的旧开始） */
  const startsBySection = useMemo(() => {
    const map: Record<string, { active: boolean }[]> = {}
    for (const s of state.starts) {
      ;(map[s.sectionId] ||= []).push({ active: s.active })
    }
    return map
  }, [state.starts])

  /* —— 一次性轻提示：生词可点开 / 今译可开启 —— */
  const [hintsShown, setHintsShown] = useState<{ gloss: boolean; vernacular: boolean }>(() => ({
    gloss: sessionStorage.getItem('mdt.hint.gloss') === '1',
    vernacular: sessionStorage.getItem('mdt.hint.vernacular') === '1',
  }))
  const [showUnderlineHint, setShowUnderlineHint] = useState<boolean>(
    () => !sessionStorage.getItem('mdt.hint.underline') && state.underlines.filter(u => u.id !== 'auto-first-echo').length === 0,
  )
  const dismissHint = (key: 'gloss' | 'vernacular') => {
    sessionStorage.setItem(`mdt.hint.${key}`, '1')
    setHintsShown(h => ({ ...h, [key]: true }))
  }

  /* —— 显现门控：哨兵进入视口即显现身后的段落 —— */
  useEffect(() => {
    if (maxRevealed < 0) setMaxRevealed(0)
  }, []) // eslint-disable-line

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const sentinels = Array.from(root.querySelectorAll<HTMLElement>('.sentinel'))
    const io = new IntersectionObserver(
      entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const next = Math.min(Number((en.target as HTMLElement).dataset.next), visible.length - 1)
          if (next > maxRevealedRef.current) {
            setMaxRevealed(next)
            hintsFnRef.current(next)
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    sentinels.forEach(s => io.observe(s))
    return () => io.disconnect()
  }, [visible]) // eslint-disable-line

  /* —— 持久化进度 —— */
  useEffect(() => {
    update(s =>
      maxRevealed > s.progress.maxRevealed
        ? { ...s, progress: { ...s.progress, maxRevealed } }
        : s,
    )
  }, [maxRevealed]) // eslint-disable-line

  /* —— 首分钟示范：书先替读者留住“不到园林”，再让后文原句回应 —— */
  useEffect(() => {
    if (chapter.chapterId !== '10') return
    const sourceIndex = visible.findIndex(section => section.id === '10-06')
    if (sourceIndex < 0 || maxRevealed < sourceIndex) return
    if (state.underlines.some(line => line.id === 'auto-first-echo')) return
    const section = chapter.sections.find(item => item.id === '10-06')
    const text = section ? sectionText(section) : ''
    const sourceText = '不到园林，怎知春色如许'
    const startOffset = text.indexOf(sourceText)
    if (startOffset < 0) return
    const underline: Underline = {
      id: 'auto-first-echo',
      questionId: null,
      sectionId: '10-06',
      text: sourceText,
      startOffset,
      endOffset: startOffset + sourceText.length,
      createdAt: Date.now(),
      readingPosition: '10-06',
      boundEchoIds: ['e1', 'x12-1'],
      inferenceSource: 'local',
      inferenceConfidence: 1,
    }
    update(current => ({ ...current, underlines: [...current.underlines, underline] }))
    setBookNote({ sectionId: '10-06', text: '先不用操作。书替你留住了这一句。' })
    window.setTimeout(() => setBookNote(null), motion ? 4200 : 2400)
  }, [chapter, maxRevealed, motion, state.underlines, update, visible])

  /* —— 梦境 / 梦醒的书页转换 —— */
  useEffect(() => {
    const prev = prevStageRef.current
    if (currentStage === 'dream' && prev !== 'dream') {
      document.body.classList.add('stage-dream')
      playDreamCue(state.settings.sound)
      setAmbientDream(true)
    }
    if (currentStage === 'wake' && prev === 'dream') {
      document.body.classList.remove('stage-dream')
      stopDreamCue() // 引音中断
      setAmbientDream(false)
    }
    if (currentStage === 'reality') document.body.classList.remove('stage-dream')
    prevStageRef.current = currentStage
  }, [currentStage, state.settings.sound])

  /* —— 演出总谱同时调度音乐密度、梦醒截断与页面阶段 —— */
  useEffect(() => {
    document.body.dataset.performancePhase = performanceCue.id
    setPerformanceMusic(
      performanceCue.music.mode,
      performanceCue.music.intensity,
      state.settings.sound,
      performanceCue.music.hardCut,
    )
    return () => { delete document.body.dataset.performancePhase }
  }, [performanceCue, state.settings.sound])

  useEffect(
    () => () => {
      document.body.classList.remove('stage-dream')
      stopDreamCue()
    },
    [],
  )

  /* —— 跳过：点击或空格，立即完成所有显现 —— */
  const skip = useCallback(() => {
    setSkipAll(true)
    window.setTimeout(() => setSkipAll(false), 400)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSel(null); setGloss(null); setCancelPop(null); setJuxtapose(null)
        return
      }
      if ((e.code === 'Space' || e.key === ' ') && !(e.target instanceof HTMLTextAreaElement)) {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return // 有选区时不抢空格
        e.preventDefault()
        skip()
      }
      if (e.key === 'Enter' && sel) {
        e.preventDefault()
        keepSelection(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip, sel]) // eslint-disable-line

  /* —— 回声提示：新显现的段落命中某条划线的已审核回应 —— */
  const maybeShowHints = useCallback(
    (revealedIdx: number) => {
      if (revealedIdx <= restoredRef.current) return // 恢复进度时不打扰
      const section = visible[revealedIdx]
      if (!section) return
      const found: JuxtaposeData[] = []
      const seenEcho = new Set<string>()
      for (const u of state.underlines) {
        for (const eid of u.boundEchoIds) {
          const echo = chapter.echoes.find(e => e.id === eid)
          if (!echo || echo.targetSectionId !== section.id || seenEcho.has(echo.id)) continue
          // 剧透边界：读者已到达 earliestAt 才允许提示
          if (chapterOrder.indexOf(section.id) < chapterOrder.indexOf(echo.earliestAt)) continue
          seenEcho.add(echo.id)
          found.push({ echo, underline: u })
        }
      }
      if (found.length) {
        setHints(prev => ({
          ...prev,
          [section.id]: [...(prev[section.id] || []), ...found],
        }))
      }
    },
    [visible, state.underlines, chapter, chapterOrder],
  )
  hintsFnRef.current = maybeShowHints

  /* —— 选择文字 → 留下这句 / 设为开始 —— */
  const handleSelectEnd = useCallback(() => {
    window.setTimeout(() => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return
      const range = selection.getRangeAt(0)
      const sectionEl =
        (range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement
        )?.closest('.section') as HTMLElement | null
      if (!sectionEl || !containerRef.current?.contains(sectionEl)) return
      const sectionId = sectionEl.dataset.sid!
      const start = locateOffset(sectionEl, range.startContainer, range.startOffset)
      const end = locateOffset(sectionEl, range.endContainer, range.endOffset)
      if (start == null || end == null || start >= end) return
      const text = sectionText(chapter.sections.find(s => s.id === sectionId)!).slice(start, end)
      if (!text.trim() || text.length > 120) return
      const rect = range.getBoundingClientRect()
      setSel({
        x: Math.min(rect.left + rect.width / 2, window.innerWidth - 120),
        y: rect.bottom + 8,
        sectionId,
        start,
        end,
        text,
      })
    }, 10)
  }, [chapter])

  const keepSelection = useCallback(async (asStart: boolean) => {
    if (!sel) return
    const interpretation = await interpretUnderline(sel.text, sel.sectionId, chapter)
    const echoes = await findReviewedEchoes(interpretation, chapter)
    const underline: Underline = {
      id: `u${Date.now().toString(36)}`,
      questionId: null,
      sectionId: sel.sectionId,
      text: sel.text,
      startOffset: sel.start,
      endOffset: sel.end,
      createdAt: Date.now(),
      readingPosition: visible[maxRevealedRef.current]?.id || sel.sectionId,
      boundEchoIds: echoes.map(e => e.id),
      inferenceSource: interpretation.source,
      inferenceConfidence: interpretation.confidence,
    }
    update(s => {
      const starts = asStart
        ? [
            ...s.starts.map(x => ({ ...x, active: false })),
            { id: underline.id, sectionId: sel.sectionId, text: sel.text, createdAt: underline.createdAt, active: true },
          ]
        : s.starts
      return { ...s, underlines: [...s.underlines, underline], starts }
    })
    // 读者第一次划线后，关闭引导提示
    if (showUnderlineHint) {
      setShowUnderlineHint(false)
      sessionStorage.setItem('mdt.hint.underline', '1')
    }
    setSel(null)
    window.getSelection()?.removeAllRanges()
    setBookNote({
      sectionId: sel.sectionId,
      text: interpretation.source === 'deepseek'
        ? (asStart ? 'DeepSeek 已理解，并把开始放在这里。' : 'DeepSeek 已理解这句，候选关系仍经过人工审核。')
        : (asStart ? '本地规则已记录这个开始。' : '本地规则已记住这句；连接API后会进行语义理解。'),
    })
    window.setTimeout(() => setBookNote(null), motion ? 4600 : 2600)
  }, [sel, chapter, update, visible, motion])

  const cancelUnderline = useCallback(
    (u: Underline) => {
      update(s => ({ ...s, underlines: s.underlines.filter(x => x.id !== u.id) }))
      setCancelPop(null)
    },
    [update],
  )

  /* —— 生词 —— */
  const openGloss = useCallback((word: string, meaning: string, ev: React.MouseEvent) => {
    ev.stopPropagation()
    const rect = (ev.target as HTMLElement).getBoundingClientRect()
    setGloss({ x: Math.min(rect.left, window.innerWidth - 240), y: rect.bottom + 6, word, meaning })
  }, [])

  const openUline = useCallback((u: Underline, ev: React.MouseEvent) => {
    ev.stopPropagation()
    const rect = (ev.target as HTMLElement).getBoundingClientRect()
    setCancelPop({ x: rect.left, y: rect.bottom + 6, underline: u })
  }, [])

  useEffect(() => {
    const close = () => { setGloss(null); setCancelPop(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  /* —— 线头随滚动淡出，不与正文相撞 —— */
  const [scrolledAway, setScrolledAway] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolledAway(window.scrollY > 220)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* —— 渲染 —— */
  let firstWakeSeen = false
  const firstGlossId = visible.find(s => s.glosses.length > 0)?.id

  return (
    <div
      className={`reader ${skipAll ? 'skip-all' : ''}`}
      ref={containerRef}
      onMouseUp={handleSelectEnd}
      onTouchEnd={handleSelectEnd}
    >
      {/* 红线：主线问题的实体。极细、极淡，不加装饰 */}
      <div className="red-thread" aria-hidden="true" />
      <div
        className={`living-stage phase-${performanceCue.id}`}
        style={{
          '--bloom': performanceCue.visual.bloom,
          '--density': performanceCue.visual.density,
        } as React.CSSProperties}
        aria-hidden="true"
      >
        <div className="bloom bloom-main">
          <span className="bloom-heart" />
          {Array.from({ length: 8 }, (_, i) => (
            <span className="bloom-petal" key={i} style={{ '--petal': i } as React.CSSProperties} />
          ))}
        </div>
        <div className="bloom bloom-echo" />
      </div>

      <header className="reader-head">
        第{chapter.chapterId === '10' ? '十' : chapter.chapterId === '12' ? '十二' : chapter.chapterId}出　{chapter.chapterTitle}
        {state.settings.demoMode && (
          <span className="demo-tag">
            演示节选 · 为演示时长节选段落，<button onClick={onOpenCatalog}>完整阅读见目录</button>
          </span>
        )}
      </header>

      <div className="textcol">
        {visible.map((section, idx) => {
          const revealed = idx <= maxRevealed
          const isFirstWake = section.stage === 'wake' && !firstWakeSeen
          if (section.stage === 'wake') firstWakeSeen = true
          const whisperAfter = chapter.whispers.find(
            w => w.startAfter === section.id && (!w.when || (w.when === 'hasStart' && !!activeStart)),
          )
          const sectionHints = hints[section.id] || []
          const ul = underlinesBySection[section.id] || []
          const isZL = section.revealStyle === 'zaolaopao'
          const sectionCue = getPerformanceCue(section.id, chapterOrder)
          const phaseEntrance = isPhaseEntrance(section.id, sectionCue)

          return (
            <React.Fragment key={section.id}>
              <div className="sentinel" data-next={idx} style={{ height: 1 }} aria-hidden="true" />
              {revealed && phaseEntrance && sectionCue.entryCue && sectionCue.guide.mode !== 'silent' && (
                <aside className={`guide-cue guide-${sectionCue.guide.mode}`}>
                  <span className="guide-cue-label">引路 · 非原文</span>
                  <span className="guide-cue-text">{sectionCue.entryCue}</span>
                  <span className="guide-cue-phase">
                    {sectionCue.label} · {sectionCue.thread.node}
                  </span>
                </aside>
              )}
              {/* 回声提示：页边重现旧下划线 */}
              {revealed &&
                sectionHints.map(h => (
                  <div className="echo-hint" key={h.echo.id}>
                    <span className="ghost-stroke">{h.underline.text}</span>
                    <button className="ghost-line" onClick={() => setJuxtapose(h)}>
                      刚才那句话，在这里有了回声。
                    </button>
                  </div>
                ))}

              <section
                className={[
                  'section',
                  `type-${section.type}`,
                  revealed ? 'revealed' : '',
                  section.stage === 'dream' ? 'stage-dream-section' : '',
                  isFirstWake ? 'wake-first' : '',
                ].join(' ')}
                data-sid={section.id}
                aria-hidden={!revealed}
              >
                {/* 红线针脚：「开始」落在这里；旧的开始变淡留在原地 */}
                {(startsBySection[section.id] || []).map((st, i) => (
                  <span
                    key={i}
                    className={`stitch ${st.active ? 'active' : 'past'}`}
                    style={{ top: `calc(1.1em + ${i * 4}px)` }}
                    aria-hidden="true"
                  />
                ))}
                {section.tune && <span className="tune-name">{section.tune}</span>}
                {section.segments.map((seg, si) => {
                  const segStart = segStarts[section.id][si]
                  const hasUline = ul.some(
                    u => u.startOffset < segStart + seg.text.length && u.endOffset > segStart,
                  )
                  const decorated = decorateSegment(
                    seg.text, segStart, section, ul, dreamFaded, openUline, openGloss,
                  )
                  const useZL = isZL && si === 0 && motion && revealed && !hasUline
                  const zlSpace = isZL && si === 1
                  const zlDelay = isZL && motion ? (si === 1 ? 3400 : si >= 2 ? 4400 : 0) : 0
                  return (
                    <p
                      key={si}
                      className={[
                        'seg',
                        'text-line',
                        seg.inner ? 'inner' : '',
                        seg.aside ? 'aside' : '',
                        zlSpace ? 'zl-space' : '',
                        zlDelay ? 'zl-pending' : '',
                      ].join(' ')}
                      style={zlDelay ? { transitionDelay: `${zlDelay}ms` } : undefined}
                    >
                      {seg.speaker && <span className="speaker">{seg.speaker}</span>}
                      <span className="seg-text" data-segstart={segStart}>
                        {useZL ? <ZaoLuoPaoLine text={seg.text} revealed={revealed} /> : decorated}
                      </span>
                      {seg.stageHint && <span className="stage-hint">{seg.stageHint}</span>}
                    </p>
                  )
                })}
                {bookNote?.sectionId === section.id && (
                  <div className="book-note" role="status">{bookNote.text}</div>
                )}
              </section>

              {/* 今译对照：默认关，标注非原文，不参与划线 */}
              {state.settings.vernacular && section.vernacular && revealed && (
                <p className="vernacular">
                  <span className="vn-tag">今译 · 非原文</span>
                  {section.vernacular}
                </p>
              )}

              {/* 一次性轻提示 */}
              {!hintsShown.gloss && revealed && section.id === firstGlossId && (
                <button className="faint-hint" onClick={() => dismissHint('gloss')}>
                  带点的词，可以点开看
                </button>
              )}
              {!hintsShown.vernacular && !state.settings.vernacular && revealed && section.id === '10-04' && (
                <button className="faint-hint" onClick={() => dismissHint('vernacular')}>
                  读不顺的话，右上角可以开今译对照
                </button>
              )}
              {showUnderlineHint && revealed && section.id === '10-06' && (
                <div className="underline-hint" onClick={() => { setShowUnderlineHint(false); sessionStorage.setItem('mdt.hint.underline', '1') }}>
                  <span className="underline-hint-arrow">↳</span>
                  <span className="underline-hint-text">选一句在意的，划下来——你划下的，后文会回应</span>
                </div>
              )}

              {/* 页边低语：只调整注意力，不索要答案 */}
              {whisperAfter && revealed && (
                <aside className="margin-whisper" role="note">
                  {whisperAfter.text}
                </aside>
              )}
            </React.Fragment>
          )
        })}

        {/* 读完：合上这一出 */}
        {maxRevealed >= visible.length - 1 && (
          <div className="finish-entry">
            <button
              className="text-entry"
              onClick={() => {
                update(s => ({ ...s, progress: { ...s.progress, finished: true } }))
                onFinish()
              }}
            >
              合上这一出
            </button>
          </div>
        )}

        <footer className="reader-footer">
          <button className="text-entry-small" onClick={onOpenCatalog}>五十五出目录</button>
          <button className="text-entry-small" onClick={onOpenAbout}>这本书刚才做了什么？</button>
        </footer>
      </div>

      {/* 留下这句 / 设为开始 */}
      {sel && (
        <div
          className="keep-pop-row"
          style={{ left: sel.x, top: sel.y, transform: 'translateX(-50%)' }}
        >
          <button className="keep-pop" onClick={() => keepSelection(false)} autoFocus>
            留下这句
          </button>
          <button className="keep-pop" onClick={() => keepSelection(true)}>
            {activeStart ? '改从这里开始' : '设为开始'}
          </button>
        </div>
      )}

      {/* 书签槽：红线的线头。未设开始时，先把整个问题放出来；滚动后淡出 */}
      <div className={`bookmark-slot ${scrolledAway ? 'scrolled-away' : ''}`} aria-live="polite">
        <span className="bs-label">
          {activeStart ? '你目前认为，一切开始于——' : '从哪一句开始，她再也回不到原来的生活？'}
        </span>
        {activeStart && (
          <span className="bs-text">
            「{activeStart.text.length > 14 ? activeStart.text.slice(0, 14) + '…' : activeStart.text}」
          </span>
        )}
      </div>

      {/* 生词释义 */}
      {gloss && (
        <div className="gloss-pop" style={{ left: gloss.x, top: gloss.y }} role="tooltip" onClick={e => e.stopPropagation()}>
          <span className="gloss-title">{gloss.word}</span>
          {gloss.meaning}
        </div>
      )}

      {/* 取消划线 */}
      {cancelPop && (
        <button
          className="keep-pop"
          style={{ left: cancelPop.x, top: cancelPop.y }}
          onClick={() => cancelUnderline(cancelPop.underline)}
        >
          取消划线
        </button>
      )}

      {/* 原文并置 */}
      {juxtapose && <Juxtapose data={juxtapose} onClose={() => setJuxtapose(null)} />}
    </div>
  )
}
