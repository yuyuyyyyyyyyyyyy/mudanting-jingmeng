import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Chapter, Section, AttentionState, AttentionOption, StagingResolution, Pace } from '../types'
import type { Persisted } from '../store'
import {
  getPerformanceCue, performanceScore, makeBeatId, getStagingBeat, getCandidatesForBeat,
  normalizeAttentionState, applyAttentionChoice, requestStagingCue, paceDelayMs,
} from '../performance'
import { setPerformanceMusic, stopAmbient, stopDreamCue, applyStagingCue } from '../sound'
import { getDreamOrchestrator, resetDreamOrchestrator } from '../dream-orchestrator'
import { getWhisperAgent, resetWhisperAgent, type Whisper } from '../whisper-agent'
import { getEchoAgent, resetEchoAgent, type EchoResult } from '../echo-agent'
import { getReadingBiasAgent, resetReadingBiasAgent } from '../reading-bias-agent'
import { requestPlan, type PlanResult } from '../performance'
import type { DreamDecision } from '../dream-law'
import type { WindowKey } from '../dream-law'

interface Props {
  chapter: Chapter
  state: Persisted
  update: (fn: (s: Persisted) => Persisted) => void
  onOpenReader: () => void
  onFinish: () => void
}

interface Beat {
  section: Section
  sectionIndex: number
  segmentIndex: number
  speaker: string
  text: string
  stageHint?: string
}

// 人工审核的「选项 → 即时调度 cue」映射
const OPTION_CUE: Record<string, { visualCue: string; soundCue: string; pace: Pace }> = {
  hear_birds: { visualCue: 'window_light', soundCue: 'bird_distant', pace: 'flow' },
  see_her: { visualCue: 'mirror_focus', soundCue: 'room_hush', pace: 'hold' },
  open_gate: { visualCue: 'gate_open', soundCue: 'strings_rise', pace: 'flow' },
  mirror_self: { visualCue: 'mirror_focus', soundCue: 'room_hush', pace: 'hold' },
  follow_bloom: { visualCue: 'bloom_expand', soundCue: 'bird_distant', pace: 'flow' },
  trace_ruin: { visualCue: 'ruin_reveal', soundCue: 'strings_thin', pace: 'hold' },
}

const BASELINE_CUE = { visualCue: 'baseline', soundCue: 'baseline', pace: 'flow' as Pace }

// 司梦低语的语气 → 中性引导短语（不分析读者，只引导注意力方向）
const WHISPER_GUIDE: Record<'observe' | 'echo' | 'hold' | 'shift', string> = {
  observe: '看这句里什么留住了你',
  echo: '戏台记得你留下的痕迹',
  hold: '在这里停一停',
  shift: '戏要转向了',
}

export default function Performance({ chapter, state, update, onOpenReader, onFinish }: Props) {
  const visible = useMemo(
    () => state.settings.demoMode
      ? chapter.sections.filter(section => chapter.demoSectionIds.includes(section.id))
      : chapter.sections,
    [chapter, state.settings.demoMode],
  )
  const chapterOrder = useMemo(() => chapter.sections.map(section => section.id), [chapter])
  const beats = useMemo<Beat[]>(
    () => visible.flatMap((section, sectionIndex) =>
      section.segments.map((segment, segmentIndex) => ({
        section,
        sectionIndex,
        segmentIndex,
        speaker: segment.speaker,
        text: segment.text,
        stageHint: segment.stageHint,
      })),
    ),
    [visible],
  )

  const [beatIndex, setBeatIndex] = useState(0)
  const beat = beats[Math.min(beatIndex, beats.length - 1)]

  const attentionRef = useRef<AttentionState>(normalizeAttentionState(state.attention))
  useEffect(() => {
    attentionRef.current = normalizeAttentionState(state.attention)
  }, [state.attention])

  type Phase = 'choosing' | 'resolving' | 'auto' | 'idle'
  const [phase, setPhase] = useState<Phase>('idle')
  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null)
  const [stagingHint, setStagingHint] = useState<string | null>(null)
  const [cue, setCue] = useState(() => getPerformanceCue(beat?.section.id || '10-01', chapterOrder))
  const [currentStaging, setCurrentStaging] = useState(BASELINE_CUE)
  const [resolution, setResolution] = useState<StagingResolution | null>(null)
  const [echoText, setEchoText] = useState<string | null>(null)
  const [showEchoReason, setShowEchoReason] = useState(false)
  const [canContinue, setCanContinue] = useState(false)

  const dream = getDreamOrchestrator()
  const [dreamPhase, setDreamPhase] = useState<'collecting' | 'active' | 'done'>('active')
  const [dreamMemoryAsked, setDreamMemoryAsked] = useState(true)
  const [dreamMemoryText, setDreamMemoryText] = useState('')
  const [dreamDecision, setDreamDecision] = useState<DreamDecision | null>(null)
  const [dreamDescription, setDreamDescription] = useState<string>('')
  const [dreamConsentAsked, setDreamConsentAsked] = useState(false)
  const [dreamConsentInput, setDreamConsentInput] = useState('')
  const dreamRef = useRef(dream)
  dreamRef.current = dream

  const whisperAgent = getWhisperAgent()
  const [whisper, setWhisper] = useState<Whisper | null>(null)
  const [whisperTyping, setWhisperTyping] = useState('')
  const [whisperLoading, setWhisperLoading] = useState(false)
  const whisperRef = useRef(whisperAgent)
  whisperRef.current = whisperAgent
  const lastBeatIndexRef = useRef(-1)
  const beatEnterTimeRef = useRef(Date.now())
  const cueRef = useRef(cue)
  cueRef.current = cue
  const dreamMemoryAskedRef = useRef(false)
  dreamMemoryAskedRef.current = dreamMemoryAsked

  const echoAgent = getEchoAgent()
  echoAgent.setSectionOrder(chapterOrder)
  const [echoResult, setEchoResult] = useState<EchoResult | null>(null)
  const [visualEffect, setVisualEffect] = useState<string>('neutral')
  const [traces, setTraces] = useState<string[]>([])
  const echoAgentRef = useRef(echoAgent)
  echoAgentRef.current = echoAgent
  const choiceCountRef = useRef(0)
  const lastPhaseRef = useRef('')
  const echoDismissTimerRef = useRef<number | null>(null)

  const readingBiasAgent = getReadingBiasAgent()
  const hasTriggeredAdaptiveEcho = useRef(false)
  const planResultRef = useRef<PlanResult | null>(null)

  const cueToWindow = (cueId: string): WindowKey | null => {
    switch (cueId) {
      case 'chamber':   return 'enter_garden'
      case 'threshold': return 'enter_garden'
      case 'garden':    return 'spring_full'
      case 'self':      return 'spring_fading'
      case 'dream':     return 'boundary_soft'
      case 'wake':      return 'awaken'
      case 'aftermath': return null
      default:          return null
    }
  }

  const advanceTimer = useRef<number | null>(null)
  const resolveSeq = useRef(0)
  const firstBeatRef = useRef(true)
  const autoChooseTimerRef = useRef<number | null>(null)
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase

  const beatId = beat ? makeBeatId(beat.section.id, beat.segmentIndex) : ''
  const stagingBeat = beatId ? getStagingBeat(beatId) : undefined

  useEffect(() => {
    document.body.dataset.performancePhase = cue.id
    document.body.classList.toggle('stage-dream', cue.id === 'dream')
    try { setPerformanceMusic(cue.music.mode, cue.music.intensity, state.settings.sound, cue.music.hardCut) } catch {}
    try { applyStagingCue('baseline', 'flow', state.settings.sound) } catch {}
    setCurrentStaging(BASELINE_CUE)

    const winKey = cueToWindow(cue.id)
    if (winKey && dreamPhase === 'active') {
      const response = winKey === 'dream_enter' && !dreamConsentAsked
        ? { kind: 'silence' as const }
        : { kind: 'none' as const }
      dreamRef.current.decideAtWindow(winKey, response).then(d => {
        if (d) {
          setDreamDecision(d)
          setDreamDescription(dreamRef.current.describeDecision(d))
        }
      })
    }
    return () => {
      delete document.body.dataset.performancePhase
      document.body.classList.remove('stage-dream')
    }
  }, [cue, state.settings.sound])

  // 把一句低语落到 UI：写入历史、停思考态、打字展开
  function applyWhisper(text: string, tone: Whisper['tone'], source: Whisper['source']) {
    const w: Whisper = { text, tone, source, timestamp: Date.now() }
    whisperRef.current.getHistory().push(w)
    setWhisperLoading(false)
    setWhisper(w)
    setWhisperTyping(w.text.slice(0, 1))
    let i = 1
    const timer = setInterval(() => {
      i++
      setWhisperTyping(w.text.slice(0, i))
      if (i >= w.text.length) clearInterval(timer)
    }, 45)
  }

  // 本地兜底低语：API 离线/失败/超时时，用中性引导让戏台仍在场
  // （不分析读者、不生成原文，仅引导注意力方向，符合「绝不卡住阅读」）
  function applyLocalWhisper(action: 'advance' | 'choose' | 'pause' | 'revisit' | 'shift') {
    const fallback: Record<string, string> = {
      advance: '戏台在看这句。',
      choose: '你留意了，戏台记得。',
      shift: '戏要转向了。',
      pause: '停一停也好。',
      revisit: '又看一遍这句。',
    }
    applyWhisper(fallback[action] || '看这句里什么留住了你。', 'observe', 'local')
  }

  async function triggerWhisper(action: 'advance' | 'choose' | 'pause' | 'revisit' | 'shift', choiceLabel?: string) {
    const pauseMs = Date.now() - beatEnterTimeRef.current
    // 先校验是否应当低语：与上一次间隔太近就跳过，不进入"思考中"状态
    const last = whisperRef.current.getLast()
    const now = Date.now()
    if (last) {
      const gap = now - last.timestamp
      // 间隔控制：避免刷屏，但推进时允许较频繁更新，让低语跟随戏台
      if (action === 'choose' && gap < 1200) return
      if (action === 'shift' && gap < 2500) return
      if (gap < 1500) return  // advance / pause / revisit
    }
    setWhisperLoading(true)
    try {
      const res = await fetch('/api/dream-whisper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phaseId: cue.id,
          phaseLabel: cue.label,
          beatText: beat?.text || '',
          readerAction: action,
          choiceLabel: choiceLabel || '',
          pauseMs,
          memoryRawText: dreamRef.current.getMemoryRawText(),
          dreamDecisionDesc: dreamDescription,
          recentWhispers: whisperRef.current.getHistory().slice(-3).map(w => w.text),
        }),
      })
      if (!res.ok) { applyLocalWhisper(action); return }
      const data = await res.json()
      const text = String(data.whisper || '').slice(0, 60)
      if (!text) { applyLocalWhisper(action); return }
      const tone = (['observe','echo','hold','shift'].includes(data.tone) ? data.tone : 'observe') as Whisper['tone']
      const source = data.source === 'deepseek' ? 'deepseek' : 'local'
      applyWhisper(text, tone, source)
    } catch(e) { applyLocalWhisper(action) }
  }

  async function triggerEcho() {
    const echoes = chapter.echoes.map(e => ({
      id: e.id, sourceText: e.sourceText, targetText: e.targetText,
      relation: e.relation, explanation: e.explanation,
      earliestAt: e.earliestAt,
    }))
    if (!echoes.length) return
    try {
      const result = await echoAgentRef.current.echo({
        phaseId: cueRef.current.id,
        phaseLabel: cueRef.current.label,
        beatText: beat?.text || '',
        currentSectionId: beat?.section.id || '',
        dominantMotifs: attentionRef.current.dominantMotifs,
        recentChoices: attentionRef.current.recentChoices.map(c => ({
          optionId: c.optionId, motifs: c.motifs,
        })),
        echoes,
      })
      if (result) {
        setEchoResult(result)
      }
    } catch {}
  }

  async function submitMemory() {
    const text = dreamMemoryText.trim() || '春风拂过旧庭院的一角，落英飘过石阶。'
    await dream.collectMemory(text)
    setDreamMemoryAsked(true)
    setDreamConsentAsked(true)
    const d = await dream.decideAtWindow('dream_enter', { kind: 'silence' })
    if (d) { setDreamDecision(d); setDreamDescription(dream.describeDecision(d)) }
    setTimeout(() => {
      triggerWhisper('shift')
      scheduleAdvance('flow', beat?.section?.vernacular?.length || 0)
    }, 800)
  }

  async function submitConsent() {
    const text = dreamConsentInput.trim()
    setDreamConsentAsked(true)
    const response = text
      ? { kind: 'affirm' as const, rawText: text }
      : { kind: 'silence' as const }
    const d = await dream.decideAtWindow('dream_enter', response)
    if (d) {
      setDreamDecision(d)
      setDreamDescription(dream.describeDecision(d))
    }
  }

  function applyResolution(res: StagingResolution) {
    setCurrentStaging({
      visualCue: res.candidate.visualCue,
      soundCue: res.candidate.soundCue,
      pace: res.candidate.pace,
    })
    try { applyStagingCue(res.candidate.soundCue, res.candidate.pace, state.settings.sound) } catch {}
    if (res.candidate.echoId) {
      const echo = chapter.echoes.find(e => e.id === res.candidate.echoId)
      if (echo) setEchoText(echo.sourceText)
    }
  }

  function scheduleAdvance(pace: Pace, vernacularLen = 0) {
    if (advanceTimer.current !== null) clearTimeout(advanceTimer.current)
    const originalLen = beat?.text?.length || 0
    const readMs = Math.min(4500, Math.max(800, originalLen * 180 + (vernacularLen || 0) * 60))
    const delay = paceDelayMs(pace, state.settings.motion, readMs)
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null
      doAdvance()
    }, delay)
  }

  function doAdvance() {
    if (!beat) return
    if (cueRef.current.id === 'dream' && !dreamMemoryAskedRef.current) return
    update(current => ({
      ...current,
      progress: {
        ...current.progress,
        maxRevealed: Math.max(current.progress.maxRevealed, beat.sectionIndex),
      },
      attention: attentionRef.current,
    }))
    if (beatIndex >= beats.length - 1) {
      if (cueRef.current.id === 'aftermath') triggerEcho()
      onFinish()
      return
    }
    setBeatIndex(i => i + 1)
    // 推进时尝试低语：间隔够才真正触发（间隔检查在 triggerWhisper 内）
    triggerWhisper('advance')
  }

  useEffect(() => {
    setChosenOptionId(null)
    setStagingHint(null)
    setEchoText(null)
    setShowEchoReason(false)
    // 不清除 whisper：让上一句低语自然停留，直到被新低语覆盖
    // （中性低语保留比消失更连贯；只清除思考态，避免指示器残留）
    setWhisperLoading(false)
    if (advanceTimer.current !== null) { clearTimeout(advanceTimer.current); advanceTimer.current = null }

    if (!beat) return
    const newCue = getPerformanceCue(beat.section.id, chapterOrder)
    setCue(newCue)
    const id = makeBeatId(beat.section.id, beat.segmentIndex)
    const sb = getStagingBeat(id)

    if (sb && sb.options?.length) {
      setPhase('choosing')
      // 首次进入演出页：即使第一句是选择点，也先给一句引导低语
      if (firstBeatRef.current) {
        firstBeatRef.current = false
        setTimeout(() => {
          applyWhisper('看到什么让你留意的？点一下便好。', 'observe', 'local')
        }, 500)
      }
      autoChooseTimerRef.current = setTimeout(() => {
        if (phaseRef.current === 'choosing' && sb.options?.length) {
          chooseOption(sb.options[0])
        }
      }, 4000)
      return
    }
    if (sb && sb.resolve) {
      setPhase('resolving')
      const seq = ++resolveSeq.current
      const candidates = getCandidatesForBeat(id)

      if (id === '10-08#0') {
        const biasResult = readingBiasAgent.getResult()
        if (biasResult) {
          requestPlan({
            beatId: id,
            currentText: beat.text,
            bias: biasResult.bias,
            confidence: biasResult.confidence,
            scores: biasResult.scores,
            evidence: biasResult.evidence.map(e => ({
              id: e.id, source: e.source, bias: e.bias, weight: e.weight,
              text: e.text, beatId: e.beatId,
            })),
            reviewedCandidates: candidates,
          }).then(plan => {
            if (seq !== resolveSeq.current) return
            planResultRef.current = plan
            const candidate = candidates.find(c => c.id === plan.candidateId)
            if (!candidate) return
            const res: StagingResolution = {
              candidateId: candidate.id,
              candidate,
              confidence: plan.confidence,
              dominantMotifs: [],
              source: plan.source === 'deepseek' ? 'deepseek' : 'local',
            }
            setResolution(res)
            applyResolution(res)

            if (plan.objective === 'counterbalance') {
              setVisualEffect('counterbalance')
            } else if (plan.objective === 'deepen') {
              setVisualEffect('deepen')
            } else {
              setVisualEffect('neutral')
            }

            if (!hasTriggeredAdaptiveEcho.current && (candidate as any).echoId) {
              hasTriggeredAdaptiveEcho.current = true
              const echoId = (candidate as any).echoId as string
              const echo = chapter.echoes.find(e => e.id === echoId)
              if (echo) {
                const er: EchoResult = {
                  echoId: echo.id,
                  sourceText: echo.sourceText,
                  targetText: echo.targetText,
                  relation: echo.relation,
                  reason: plan.source === 'deepseek' && plan.reason
                    ? plan.reason
                    : '戏台记得你在《皂罗袍》里停的地方。',
                  confidence: plan.confidence,
                  source: plan.source,
                  timestamp: Date.now(),
                }
                echoAgentRef.current.getHistory().push(er)
                setTimeout(() => {
                  setEchoResult(er)
                }, 1800)
              }
            }
            scheduleAdvance(res.candidate.pace, (beat?.section?.vernacular?.length || 0))
          })
          return
        }
      }

      requestStagingCue({
        chapterId: chapter.chapterId,
        beatId: id,
        currentText: beat.text,
        recentChoices: attentionRef.current.recentChoices,
        attentionWeights: attentionRef.current.weights,
        reviewedCandidates: candidates,
      }).then(res => {
        if (seq !== resolveSeq.current) return
        setResolution(res)
        applyResolution(res)
        scheduleAdvance(res.candidate.pace, (beat?.section?.vernacular?.length || 0))
      })
      return
    }
    setPhase('auto')
    scheduleAdvance('flow', (beat?.section?.vernacular?.length || 0))
    if (firstBeatRef.current) {
      firstBeatRef.current = false
      setTimeout(() => {
        applyWhisper('看到什么让你留意的？点一下便好。', 'observe', 'local')
      }, 500)
    }
  }, [beatIndex])

  useEffect(() => {
    const prevIdx = lastBeatIndexRef.current
    const curPhase = cueRef.current.id
    if (prevIdx >= 0 && beatIndex !== prevIdx) {
      beatEnterTimeRef.current = Date.now()
      if (lastPhaseRef.current && curPhase !== lastPhaseRef.current) {
        setTimeout(() => triggerWhisper('shift'), 400)
        setTimeout(() => triggerEcho(), 1200)
      }
      lastPhaseRef.current = curPhase
    } else if (!lastPhaseRef.current) {
      lastPhaseRef.current = curPhase
    }
    lastBeatIndexRef.current = beatIndex
  }, [beatIndex])

  useEffect(() => {
    if (beatId !== '10-08#0') return
    if (readingBiasAgent.getResult()) return
    const result = readingBiasAgent.decide(state)
    if (result.bias !== 'neutral') {
      // console.log('[reading-bias] 冻结:', result.bias, 'confidence:', result.confidence.toFixed(2))
    }
  }, [beatId, state, readingBiasAgent])

  function tapAdvance() {
    if (cueRef.current.id === 'dream' && !dreamMemoryAskedRef.current) return
    if (advanceTimer.current !== null) { clearTimeout(advanceTimer.current); advanceTimer.current = null }

    if (phase === 'choosing') {
      if (stagingBeat?.options?.length) {
        chooseOption(stagingBeat.options[0])
      }
      return
    }
    doAdvance()
  }

  function chooseOption(opt: AttentionOption) {
    if (phase !== 'choosing') return
    if (autoChooseTimerRef.current !== null) {
      clearTimeout(autoChooseTimerRef.current)
      autoChooseTimerRef.current = null
    }
    triggerWhisper('choose', opt.label)
    choiceCountRef.current += 1
    triggerEcho()
    setPhase('resolving')
    setChosenOptionId(opt.id)
    setTraces(prev => [...prev, opt.label])
    const next = applyAttentionChoice(attentionRef.current, beatId, opt.id, opt.motifs)
    attentionRef.current = next
    update(current => ({ ...current, attention: next }))
    window.setTimeout(() => triggerEcho(), 0)
    const oc = OPTION_CUE[opt.id] || BASELINE_CUE
    setCurrentStaging(oc)
    try { applyStagingCue(oc.soundCue, oc.pace, state.settings.sound) } catch {}
    if (opt.stagingHint) setStagingHint(opt.stagingHint)
    scheduleAdvance(oc.pace, (beat?.section?.vernacular?.length || 0))
  }

  function markStartHere() {
    if (!beat) return
    const mark = {
      id: `start-${beatId}-${Date.now().toString(36)}`,
      sectionId: beat.section.id,
      text: beat.text,
      createdAt: Date.now(),
      active: true,
    }
    update(current => ({
      ...current,
      starts: [...current.starts.map(s => ({ ...s, active: false })), mark],
    }))
    setStagingHint('先把这句留下。读到后面，你可以改变判断。')
  }

  useEffect(() => () => {
    stopAmbient()
    stopDreamCue()
    if (advanceTimer.current !== null) clearTimeout(advanceTimer.current)
    if (echoDismissTimerRef.current) clearTimeout(echoDismissTimerRef.current)
    resetDreamOrchestrator()
    resetEchoAgent()
    resetReadingBiasAgent()
  }, [])

  if (!beat) return null

  const phaseStart = beat.segmentIndex === 0 && beat.section.id === cue.from
  const progress = beats.length > 1 ? beatIndex / (beats.length - 1) : 0
  const sceneStyle = {
    '--bloom': cue.visual.bloom,
    '--density': cue.visual.density,
    '--progress': progress,
  } as CSSProperties

  const showOptions = phase === 'choosing' && stagingBeat?.options?.length
  const options = stagingBeat?.options || []
  const firstChoiceLabel = traces.length > 0 ? traces[traces.length - 1] : undefined
  const currentPhaseIndex = performanceScore.phases.findIndex(p => p.id === cue.id)
  const advanceLabel = cue.id === 'threshold' ? '走进园林' : cue.id === 'dream' ? '让梦留下' : '继续观看'

  return (
    <main
      className={`performance performance-${cue.id} effect-${visualEffect}${echoResult ? " effect-counter-read" : ""}`}
      style={sceneStyle}
      data-visual-cue={currentStaging.visualCue}
      data-sound-cue={currentStaging.soundCue}
      data-pace={currentStaging.pace}
    >
      <div className="performance-scenery" aria-hidden="true" />

      {/* 题签：极轻的章回名 + 旁通原文的入口 */}
      <header className="performance-masthead">
        <span>牡　丹　亭</span>
        <span className="masthead-divider" />
        <span>第　十　出　·　惊　梦</span>
        <button className="masthead-tap" onClick={onOpenReader}>
          看这一出原文
        </button>
      </header>

      {/* 状态：左上的极轻一行，告诉读者戏台记得什么 */}
      <div className="performance-state" aria-live="polite">
        <span className="state-dot" />
        <span className="state-text">
          {firstChoiceLabel
            ? <>戏台记得你先留意了<span className="accent">「{firstChoiceLabel}」</span></>
            : '戏台正在等你'}
        </span>
      </div>

      {/* 司梦记忆收集：仅在 dream 阶段出现 */}
      {dreamPhase === 'active' && cue.id === 'dream' && !dreamMemoryAsked && (
        <div className="dream-collect" onClick={e => e.stopPropagation()}>
          <div className="dream-collect-inner">
            <h3>今夜，你想把什么带进这场梦里？</h3>
            <p>一段想带进梦里的记忆，或不填，戏台自会记得这一停。</p>
            <textarea
              value={dreamMemoryText}
              onChange={e => setDreamMemoryText(e.target.value)}
              placeholder=""
              rows={3}
              maxLength={200}
            />
            <div className="dream-actions">
              <button onClick={() => { setDreamMemoryAsked(true); setDreamConsentAsked(true); }}>
                不带记忆入梦
              </button>
              <button
                className="primary"
                disabled={dream.isLoadingMemory()}
                onClick={submitMemory}
              >
                {dream.isLoadingMemory() ? '正在收下…' : dreamMemoryText.trim() ? '交给戏台' : '悄悄入梦'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 舞台中央：原文 + 辅助层（垂直堆叠） */}
      <section
        className="performance-stage"
        key={`${beat.section.id}-${beat.segmentIndex}`}
        onClick={tapAdvance}
      >
        {/* 相位小标 */}
        <div className="performance-phase">
          {beat.section.tune && <span>【{beat.section.tune}】</span>}
          <span className="phase-dot" />
          <span className="phase-tick">{cue.label}</span>
          <span className="phase-dot" />
          <span>{beatIndex + 1} / {beats.length}</span>
        </div>

        {/* 司梦低语：AI 思考引导（听 → 语 → 引 三阶段）
            设计灵感：
            - motionsites.ai 的 AI 驱动视觉感 → 思考时的水墨涟漪呼吸
            - reactbits.dev 的「少即是多」→ 单一克制低语层，无多余装饰
            - pinterest 的视觉发现引导 → 低语后微弱引导指向下一步 */}
        {(whisperLoading || whisper) && (
          <div
            className="performance-whisper"
            data-tone={whisper?.tone || 'observe'}
            data-source={whisper?.source || 'local'}
            data-loading={whisperLoading ? 'true' : 'false'}
            aria-live="polite"
          >
            {whisperLoading ? (
              <div className="whisper-thinking">
                <span className="whisper-ripple" aria-hidden="true" />
                <span className="whisper-ripple whisper-ripple-2" aria-hidden="true" />
                <span className="whisper-ripple whisper-ripple-3" aria-hidden="true" />
                <span className="whisper-thinking-text">司梦在听</span>
              </div>
            ) : whisper && (
              <div className="whisper-body">
                <p className="whisper-text">
                  {whisperTyping || whisper.text}
                  {whisperTyping.length < whisper.text.length && (
                    <span className="whisper-cursor" aria-hidden="true" />
                  )}
                </p>
                <span className="whisper-guide">{WHISPER_GUIDE[whisper.tone]}</span>
              </div>
            )}
          </div>
        )}

        {/* 引导句（相位切换时出现一次） */}
        {phaseStart && cue.entryCue && cue.guide.mode !== 'silent' && (
          <p className="performance-guide">{cue.entryCue}</p>
        )}

        {/* 回声：作为注脚式区域，浮在原文上方 */}
        {echoResult && (
          <div className="performance-echo" data-relation={echoResult.relation}>
            {firstChoiceLabel && (
              <span className="performance-echo-trace">
                戏台记得你先留意了「{firstChoiceLabel}」
              </span>
            )}
            <div className="performance-echo-pair">
              <div className="performance-echo-row">
                <span className="echo-tag">你留下的句子</span>
                {state.starts.find(s => s.active)?.text || echoResult.targetText}
              </div>
              <div className="performance-echo-row">
                <span className="echo-tag"><span className="echo-arrow">↓</span>回应它的原文</span>
                {echoResult.sourceText}
              </div>
            </div>
            <button
              type="button"
              className="performance-echo-toggle"
              onClick={e => { e.stopPropagation(); setShowEchoReason(v => !v) }}
            >
              {showEchoReason ? '收起依据' : '为什么这样演？'}
            </button>
            {showEchoReason && (
              <div className="performance-echo-reason">
                <span>戏台只使用你已经留下的证据：</span>
                <span>注意力：{firstChoiceLabel || '尚未选择'}</span>
                {state.starts.find(s => s.active) && (
                  <span>开始：{state.starts.find(s => s.active)?.text}</span>
                )}
                {echoResult.reason && <span>调度：{echoResult.reason}</span>}
              </div>
            )}
          </div>
        )}

        {/* 原文 */}
        <div className="performance-original">
          <p className="performance-original-text">
            {beat.speaker && <b className="speaker">{beat.speaker}</b>}
            <span>{beat.text}</span>
          </p>
          {beat.stageHint && (
            <small className="performance-original-hint">{beat.stageHint}</small>
          )}
        </div>

        {/* 划线入口：让读者把"开始"放在皂罗袍任一句 */}
        {beat.section.id === '10-07' && (
          <div className="performance-mark" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={state.starts.some(s => s.active && s.sectionId === beat.section.id && s.text === beat.text) ? 'is-set' : ''}
              onClick={markStartHere}
            >
              {state.starts.some(s => s.active && s.sectionId === beat.section.id && s.text === beat.text)
                ? '已把这句放在「开始」'
                : '把变化的开始放在这里'}
            </button>
          </div>
        )}

        {/* 今译：辅助，淡墨（默认开启） */}
        {(state.settings.vernacular || showOptions) && beat.section.vernacular && (
          <div className="performance-vernacular">
            <span className="performance-vernacular-label">今 译</span>
            <p>{beat.section.vernacular}</p>
          </div>
        )}

        {/* 选择点：像诗行一样的岔路口 */}
        {showOptions && (
          <div className="performance-choice">
            <p className="performance-choice-hint">此刻，她的目光落在何处？</p>
            <ul className="performance-choice-list">
              {options.map(opt => (
                <li key={opt.id}>
                  <button
                    type="button"
                    className={`performance-choice-item${chosenOptionId === opt.id ? ' chosen' : ''}`}
                    onClick={() => chooseOption(opt)}
                  >
                    {opt.label}
                    {opt.stagingHint && <span className="choice-staging">{opt.stagingHint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 痕迹：右侧页边，持续可见 */}
      {traces.length > 0 && (
        <aside className="performance-traces" data-highlight={echoResult ? 'true' : 'false'}>
          {traces.map((t, i) => (
            <span key={i} className="trace-word">{t}</span>
          ))}
        </aside>
      )}

      {/* 底部：相位的乐谱 + 继续提示 */}
      <footer className="performance-coda">
        <div className="performance-scoreboard" aria-label="演出进度">
          {performanceScore.phases.map((p, i) => (
            <span
              key={p.id}
              className={
                p.id === cue.id ? 'current' :
                i < currentPhaseIndex ? 'passed' : ''
              }
            >
              {p.label}
            </span>
          ))}
          <div className="score-rail" />
          <div
            className="score-rail-fill"
            style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
          />
        </div>
        {!showOptions && (
          <div className="performance-advance">
            <span>{advanceLabel}</span>
            <span className="advance-arrow" aria-hidden="true" />
          </div>
        )}
      </footer>
    </main>
  )
}
